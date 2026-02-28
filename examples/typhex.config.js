/** Example typhex config. CLI and Db.fromConfig() use this. */
export default {
  dialect: "sqlite",
  database: "./data.db",
  migrationsFolder: "./migrations",
  entities: "./src/entities.ts",
};
