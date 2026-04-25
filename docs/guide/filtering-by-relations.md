# Filtering by Relations

When a `where()` predicate references a relation property, Typhex generates a SQL `JOIN` (for `manyToOne`) or an `EXISTS` subquery (for `oneToMany`) rather than loading data in application code.

## Basic manyToOne WHERE

Filter rows by a property of a related entity:

```ts
// contacts with a where on their company name
const acmeContacts = await Contact.query()
  .where((c) => c.company.name === "Acme Corp") // [!code highlight]
  .select((c) => ({ id: c.id, name: c.name }))
  .orderBy((c) => c.id, "asc")
  .toArray();
```

```sql
SELECT contacts.id AS id, contacts.name AS name
FROM contacts
LEFT JOIN companies ON companies.id = contacts.companyId
WHERE companies.name = ?
ORDER BY contacts.id ASC
-- params: ["Acme Corp"]
```

::: tip Default JOIN type
Typhex emits a `LEFT JOIN` by default. Use [join hints](/reference/api#innerjoin-keysorfn-leftjoin-rightjoin-fulljoin-crossjoin) (`.innerJoin()`, `.rightJoin()`, etc.) to override.
:::

## JOIN Reuse: WHERE + SELECT on the Same Relation

When both `where()` and `select()` reference the same `manyToOne` relation, Typhex reuses the JOIN — no duplicate fetch:

```ts
const acmeContactsWithCompany = await Contact.query()
  .where((c) => c.company.name === "Acme Corp")
  .select((c) => ({
    id: c.id,
    name: c.name,
    company: { id: c.company.id, name: c.company.name }, // [!code highlight]
  }))
  .orderBy((c) => c.id, "asc")
  .toArray();
```

```sql
SELECT contacts.id AS id, contacts.name AS name,
       companies.id AS "company.id", companies.name AS "company.name"
FROM contacts
LEFT JOIN companies ON companies.id = contacts.companyId
WHERE companies.name = ?
ORDER BY contacts.id ASC
-- params: ["Acme Corp"]
```

## Different Relations in WHERE and SELECT

You can filter by one relation and load another — each is handled independently. The `where` relation generates a JOIN; the `select` relation loads via a separate `WHERE id IN (...)` fetch:

```ts
const acmeContactsWithCategory = await Contact.query()
  .where((c) => c.company.name === "Acme Corp")
  .select((c) => ({
    id: c.id,
    name: c.name,
    category: { id: c.category.id, name: c.category.name },
  }))
  .toArray();
```

```sql
-- 1. Main query — JOIN on companies (for WHERE), but select category FK
SELECT contacts.id AS id, contacts.name AS name, contacts.categoryId AS categoryId
FROM contacts
LEFT JOIN companies ON companies.id = contacts.companyId
WHERE companies.name = ?

-- 2. Category fetch
SELECT id, name FROM categories WHERE id IN (?, ?, ...)
```

## Spread All Columns + a Relation

Use spread syntax to include all own columns alongside a relation:

```ts
const contactsWithCompany = await Contact.query()
  .select((c) => ({ ...c, company: c.company })) // [!code highlight]
  .orderBy((c) => c.id, "asc")
  .toArray();
```

```sql
SELECT id AS id, name AS name, companyId AS companyId, categoryId AS categoryId
FROM contacts ORDER BY id ASC

SELECT id, name FROM companies WHERE id IN (?, ?, ...)
```

## oneToMany EXISTS: `.some()`

For `oneToMany` relations, use `.some()` inside `where()` to generate an `EXISTS` subquery:

```ts
// departments that have at least one employee named "Alice"
const deptsWithAlice = await Department.query()
  .where((d) => d.employees.some((e) => e.name === "Alice")) // [!code highlight]
  .select((d) => ({ id: d.id, name: d.name }))
  .toArray();
```

Typhex emits:
```sql
SELECT departments.id, departments.name
FROM departments
WHERE EXISTS (
  SELECT 1 FROM employees
  WHERE employees.departmentId = departments.id
    AND employees.name = ?
)
```

## Count with Relation WHERE

`.count()` works with any `where()` predicate, including those that reference relations:

```ts
const acmeCount = await Contact.query()
  .where((c) => c.company.name === "Acme Corp")
  .count();
```

```sql
SELECT COUNT(*) AS c
FROM contacts
LEFT JOIN companies ON companies.id = contacts.companyId
WHERE companies.name = ?
-- params: ["Acme Corp"]
```
