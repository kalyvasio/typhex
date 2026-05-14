/**
 * Select-list classification.
 *
 * A user-written `.select(...)` body can mix three kinds of references:
 * plain columns (`u.name`), relation roots (`u.author`), and members of
 * relations (`u.author.name`). How each is rendered depends on whether
 * its relation is *joined* into the main SELECT (and therefore its
 * columns can ride along) or *not joined* (and so the data has to be
 * fetched separately by the relation pipeline).
 *
 * `SelectClassifier.classify()` walks the IR select once and produces a
 * `ClassifiedSelect` that tells the rest of the planner how to handle
 * each entry:
 *
 * - **`columnPaths` / `columnAliases`** — column references that should
 *   appear in the SQL SELECT list, as `<alias>.<col>` references. These
 *   include leaf columns, joined-relation members, and any join-key
 *   columns that need to be added so the row hydrator can pair fetched
 *   relation rows with their parents.
 * - **`relationFetches`** — relations that need a separate eager-load
 *   query (one-to-many, many-to-many, or non-joined many-to-one). The
 *   relation-fetcher reads this list to produce the WHERE-IN secondary
 *   queries.
 * - **`joinedProjections`** — relations whose data came in via the JOIN
 *   and needs to be re-shaped from flat result columns back into nested
 *   objects. Drives `RelationAssembler.assembleJoined`.
 * - **`skipLoadFor`** — relation keys whose data is already in the
 *   SELECT-list via the JOIN; the eager-loader skips re-fetching these.
 *
 * The classifier is constructed once with the inputs that all five
 * helper methods share, so the methods can be small and read directly
 * from `this.*` rather than threading a context object.
 */

import type { IrSelect, IrSelectRelation } from "../../../ir/types.js";
import type {
  RelationsMap,
  RelationDef,
  RelationOptions,
  JunctionOptions,
} from "../../../entity/relations.js";
import { getPkColumnsFromSchema, type AnyEntityClass } from "../../../entity/entity.js";
import { toArray } from "../../../utils.js";
import type { RelationFetchMetadata, JoinedProjection } from "./query-plan.js";

/**
 * Result of classifying an IrSelect.
 *
 * `columnPaths` / `columnAliases` carry `null` when the original IR's
 * paths/aliases should be used verbatim — that's the no-relations
 * fast-path. Otherwise both are non-null and parallel: `columnPaths[i]`
 * is the path, `columnAliases[i]` is its SELECT-list alias.
 */
export interface ClassifiedSelect {
  columnPaths: string[][] | null;
  columnAliases: string[] | null;
  relationFetches: RelationFetchMetadata[];
  joinedProjections: JoinedProjection[];
  skipLoadFor: Set<string>;
  reusableJoinKeys: Set<string>;
}

/**
 * Sentinel used by the planner when classification isn't needed (e.g.
 * mutations like UPDATE/DELETE that have no SELECT list to classify).
 * Identity-shared so equality checks stay cheap.
 */
export const EMPTY_CLASSIFIED: ClassifiedSelect = {
  columnPaths: null,
  columnAliases: null,
  relationFetches: [],
  joinedProjections: [],
  skipLoadFor: new Set(),
  reusableJoinKeys: new Set(),
};

/**
 * Internal accumulator shape returned by the per-source classification
 * helpers (`classifyPathEntries`, `classifyRelationEntries`). They each
 * produce a partial classification that `classify()` then merges and
 * post-processes.
 */
interface PartialClassification {
  columnPaths: string[][];
  columnAliases: string[];
  relationFetches: RelationFetchMetadata[];
}

/**
 * Classifies an `IrSelect` against the known relation map.
 *
 * Constructor inputs:
 * - `select` — the IR select tree from `state.selectIr`.
 * - `relations` — the relation map of the entity being queried; used to
 *   recognise relation keys in the IR and build fetch metadata.
 * - `pkColumns` — primary-key columns of the parent entity. Used for
 *   `parentPkColumns` on to-many fetches and to ensure key columns are
 *   included for to-many parents.
 * - `reusableJoinKeys` — relation keys that the planner has decided to
 *   join into the main SELECT because the where/orderBy already need
 *   that join. When non-empty, members of these relations stay in the
 *   SELECT list rather than triggering a separate fetch.
 */
export class SelectClassifier {
  constructor(
    private readonly select: IrSelect,
    private readonly relations: RelationsMap,
    private readonly pkColumns: string[],
    private readonly reusableJoinKeys: Set<string>,
  ) {}

  /**
   * Run the classification pipeline:
   *
   * 1. Fast-path: if neither the select's paths nor its `relations` field
   *    references any known relation, return a no-op classification (the
   *    planner falls back to the IR's own paths/aliases).
   * 2. Walk `select.paths` once, populating column lists, fetch metadata,
   *    joined-projection entries, and the skip-load set as we go.
   * 3. Walk `select.relations` once, doing the same for nested-relation
   *    projections (e.g. `{ posts: p => ({ id: p.id, title: p.title }) }`).
   * 4. Add any join-key columns that fetches need but the user didn't
   *    explicitly select — the row hydrator can't pair fetched rows with
   *    parents without them.
   * 5. Stamp `parentPkColumns` onto to-many fetches.
   *
   * `joinedProjections` and `skipLoadFor` are populated incrementally
   * inside the path/relation walks rather than via two extra passes
   * because the matching condition (`reusableJoinKeys.has(...)` plus a
   * length check) is exactly the same as the one that decides whether
   * a member rides along the JOIN.
   */
  classify(): ClassifiedSelect {
    const { select, relations, reusableJoinKeys } = this;

    const hasRelations =
      select.relations?.length || select.paths.some((p) => p.length >= 1 && relations[p[0]]);

    if (!hasRelations) {
      return {
        columnPaths: null,
        columnAliases: null,
        relationFetches: [],
        joinedProjections: [],
        skipLoadFor: new Set(),
        reusableJoinKeys,
      };
    }

    const joinedKeys = reusableJoinKeys.size > 0 ? reusableJoinKeys : undefined;
    const joinedByKey = new Map<string, JoinedProjection>();
    const skipLoadFor = new Set<string>();

    const fromPaths = this.classifyPathEntries(joinedKeys, joinedByKey, skipLoadFor);
    const seenOutputKeys = new Set(fromPaths.relationFetches.map((m) => m.relation.outputKey));
    const fromRelations = this.classifyRelationEntries(
      joinedKeys,
      seenOutputKeys,
      joinedByKey,
      skipLoadFor,
    );

    const columnPaths = [...fromPaths.columnPaths, ...fromRelations.columnPaths];
    const columnAliases = [...fromPaths.columnAliases, ...fromRelations.columnAliases];
    const relationFetches = [...fromPaths.relationFetches, ...fromRelations.relationFetches];

    const { paths: keyPaths, aliases: keyAliases } = this.missingJoinKeyColumns(
      relationFetches,
      columnPaths,
    );
    columnPaths.push(...keyPaths);
    columnAliases.push(...keyAliases);

    for (const f of relationFetches) {
      if (f.relationType === "one-to-many" || f.relationType === "many-to-many") {
        f.parentPkColumns = this.pkColumns;
      }
    }

    return {
      columnPaths,
      columnAliases,
      relationFetches,
      joinedProjections: [...joinedByKey.values()].filter((p) => p.members.length > 0),
      skipLoadFor,
      reusableJoinKeys,
    };
  }

  /**
   * Walk the IR `select.paths` array — every member-access in the user's
   * select body lands here as a `string[]` path. Three cases:
   *
   * - **Leaf column** (`p.col`) — path doesn't start with a relation key,
   *   so it goes straight into the SELECT list as `<alias>.<col>`.
   * - **Relation root** (`p.author`) — path is exactly `[relKey]`. Means
   *   "fetch the whole related entity"; produces a `relationFetch`.
   * - **Relation member** (`p.author.name`) — depends on whether the
   *   relation is in `joinedRelationKeys`:
   *     - Joined → emit a column path on the JOIN's alias (rendered as
   *       e.g. `t1.name AS author_name`), record a projection entry on
   *       `joinedByKey` so the assembler can reshape the flat row, and
   *       add the relation key to `skipLoadFor` so the eager-loader
   *       doesn't redundantly fetch it.
   *     - Not joined → produce a `relationFetch` carrying just that
   *       sub-path so the eager-loader's secondary query selects only
   *       what was asked for.
   *
   * Side effects on `joinedByKey` and `skipLoadFor` mean we don't need a
   * second pass over `select.paths` to compute those outputs.
   */
  private classifyPathEntries(
    joinedRelationKeys: Set<string> | undefined,
    joinedByKey: Map<string, JoinedProjection>,
    skipLoadFor: Set<string>,
  ): PartialClassification {
    const { select, relations } = this;
    const relNames = new Set(Object.keys(relations));
    const out: PartialClassification = {
      columnPaths: [],
      columnAliases: [],
      relationFetches: [],
    };

    for (let i = 0; i < select.paths.length; i++) {
      const path = select.paths[i];
      const alias = select.aliases?.[i] ?? path[path.length - 1];

      if (path.length === 1 && relNames.has(path[0])) {
        const meta = buildRelationFetchMeta(
          { name: path[0], outputKey: alias },
          relations[path[0]],
        );
        out.relationFetches.push(meta);
      } else if (path.length > 1 && relNames.has(path[0])) {
        if (joinedRelationKeys?.has(path[0])) {
          const colAlias = select.aliases?.[i] ?? `${path[0]}_${path[path.length - 1]}`;
          out.columnPaths.push(path);
          out.columnAliases.push(colAlias);

          let proj = joinedByKey.get(path[0]);
          if (!proj) {
            proj = { relationKey: path[0], outputKey: path[0], members: [] };
            joinedByKey.set(path[0], proj);
          }
          proj.members.push({ alias: colAlias, subPath: path[path.length - 1] });
          skipLoadFor.add(path[0]);
        } else {
          const meta = buildRelationFetchMeta(
            { name: path[0], outputKey: alias, subPaths: [path.slice(1)] },
            relations[path[0]],
          );
          out.relationFetches.push(meta);
        }
      } else {
        out.columnPaths.push(path);
        out.columnAliases.push(alias);
      }
    }

    return out;
  }

  /**
   * Walk the IR `select.relations` array — these come from explicit
   * nested-relation projections (e.g. selecting `posts: p => ({ id, title })`
   * means the IR carries a `{ name: "posts", outputKey: "posts",
   * subPaths: [["id"], ["title"]] }` entry).
   *
   * `seenOutputKeys` is the set of `outputKey`s already produced by
   * `classifyPathEntries` — duplicates here would cause the relation
   * pipeline to fetch the same data twice or produce ambiguous result
   * shapes, so we just skip them.
   *
   * Joined relation with non-empty subPaths → emit each subPath as a
   * column-list entry (column names like `posts_title`), record a
   * `joinedByKey` entry (overriding `outputKey` when the user aliased
   * the relation), and add the relation to `skipLoadFor`. Non-joined or
   * no subPaths → produce a relationFetch, the eager-loader handles it.
   */
  private classifyRelationEntries(
    joinedRelationKeys: Set<string> | undefined,
    seenOutputKeys: Set<string>,
    joinedByKey: Map<string, JoinedProjection>,
    skipLoadFor: Set<string>,
  ): PartialClassification {
    const { select, relations } = this;
    const out: PartialClassification = {
      columnPaths: [],
      columnAliases: [],
      relationFetches: [],
    };

    for (const r of select.relations ?? []) {
      const relDef = relations[r.name];
      if (!relDef) {
        throw new Error(`[typhex] select relation "${r.name}" is not defined on this entity`);
      }
      if (seenOutputKeys.has(r.outputKey)) {
        throw new Error(`[typhex] select relation output "${r.outputKey}" is duplicated`);
      }
      seenOutputKeys.add(r.outputKey);

      if (joinedRelationKeys?.has(r.name) && r.subPaths?.length) {
        let proj = joinedByKey.get(r.name);
        if (!proj) {
          proj = { relationKey: r.name, outputKey: r.outputKey, members: [] };
          joinedByKey.set(r.name, proj);
        } else {
          // A path-driven entry was created earlier with `outputKey: r.name`;
          // an explicit relation entry takes precedence (user may have aliased it).
          proj.outputKey = r.outputKey;
        }

        for (const sub of r.subPaths) {
          if (sub.length > 0) {
            const alias = `${r.outputKey}_${sub.join("_")}`;
            out.columnPaths.push([r.name, ...sub]);
            out.columnAliases.push(alias);
            proj.members.push({ alias, subPath: sub[sub.length - 1] });
          }
        }
        skipLoadFor.add(r.name);
      } else {
        const meta = buildRelationFetchMeta(r, relDef);
        out.relationFetches.push(meta);
      }
    }

    return out;
  }

  /**
   * Make sure every join-key column a `relationFetch` needs is in the
   * parent's SELECT list. Without this, the relation-fetcher would have
   * the secondary query's rows but no way to pair them back to the
   * correct parent row.
   *
   * The "key" columns differ by relation kind:
   * - **to-many** (one-to-many, many-to-many): the parent's PK columns —
   *   the secondary query joins the child's FK against this.
   * - **to-one** (many-to-one, one-to-one): the parent's FK columns
   *   stored on this row.
   *
   * Returns only the *missing* keys. Anything already in `existingPaths`
   * is skipped to avoid duplicate SELECT entries (which would also break
   * the row hydrator since aliases would clash).
   */
  private missingJoinKeyColumns(
    fetches: RelationFetchMetadata[],
    existingPaths: string[][],
  ): { paths: string[][]; aliases: string[] } {
    const paths: string[][] = [];
    const aliases: string[] = [];
    const added = new Set(existingPaths.map((p) => p[0]));

    for (const meta of fetches) {
      const isMany = meta.relationType === "one-to-many" || meta.relationType === "many-to-many";
      const cols = isMany ? this.pkColumns : meta.fkColumns;
      if (isMany && cols.length === 0) {
        throw new Error(
          `[typhex] select relation "${meta.relation.name}" requires a primary key on the parent entity`,
        );
      }
      for (const col of cols) {
        if (!added.has(col)) {
          paths.push([col]);
          aliases.push(col);
          added.add(col);
        }
      }
    }
    return { paths, aliases };
  }
}

/**
 * Build the runtime metadata the relation-fetcher needs to execute a
 * secondary load for one relation, given the IR description and the
 * relation definition from the entity.
 *
 * Per relation-kind handling:
 * - **many-to-one / one-to-one**: FK columns are on the parent; PK
 *   columns come from the target's schema unless overridden by the
 *   relation's `references` option.
 * - **one-to-many**: FK columns are on the child (so we read them off
 *   the relation options); PK comes from the target schema.
 * - **many-to-many**: both FK and PK live on the junction table; the
 *   junction itself is recorded so the fetcher can build the join.
 */
function buildRelationFetchMeta(ir: IrSelectRelation, relDef: RelationDef): RelationFetchMetadata {
  const target = relDef._target();
  const targetEntity =
    target && typeof (target as Partial<AnyEntityClass>).query === "function"
      ? (target as AnyEntityClass)
      : null;
  if (!targetEntity) {
    throw new Error(`[typhex] relation "${ir.name}" target is not a queryable entity`);
  }

  const targetPkColumnsFromSchema = getPkColumnsFromSchema(targetEntity.table._schema);

  switch (relDef._relType) {
    case "many-to-one":
    case "one-to-one": {
      const opts = relDef._options as RelationOptions;
      return {
        relationType: relDef._relType,
        relation: ir,
        fkColumns: toArray(opts.foreignKey),
        targetPkColumns:
          opts.references != null ? toArray(opts.references) : targetPkColumnsFromSchema,
        targetEntity,
      };
    }
    case "one-to-many": {
      const opts = relDef._options as { foreignKey: string | string[] };
      return {
        relationType: "one-to-many",
        relation: ir,
        fkColumns: toArray(opts.foreignKey),
        targetPkColumns: targetPkColumnsFromSchema,
        targetEntity,
      };
    }
    case "many-to-many": {
      const j = relDef._options as JunctionOptions;
      return {
        relationType: "many-to-many",
        relation: ir,
        fkColumns: toArray(j.referenceKey),
        targetPkColumns: targetPkColumnsFromSchema,
        targetEntity,
        junction: {
          table: j.junction,
          foreignKey: toArray(j.foreignKey),
          referenceKey: toArray(j.referenceKey),
        },
      };
    }
    default:
      throw new Error(
        `[typhex] Unsupported relation type: ${(relDef as { _relType: string })._relType}`,
      );
  }
}
