import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Typhex",
  description: "TypeScript ORM with arrow-function query predicates",
  base: "/typhex/",

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API Reference", link: "/reference/api" },
      {
        text: "GitHub",
        link: "https://github.com/kalyvasio/typhex",
      },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Entities & Relations", link: "/guide/entities-relations" },
          { text: "Querying Relations", link: "/guide/querying-relations" },
          { text: "Filtering by Relations", link: "/guide/filtering-by-relations" },
          { text: "Aggregations", link: "/guide/aggregations" },
          { text: "Transactions", link: "/guide/transactions" },
          { text: "Bulk Operations", link: "/guide/bulk-operations" },
          { text: "TypeScript Transformer", link: "/guide/typescript-transformer" },
        ],
      },
      {
        text: "Drivers",
        items: [
          { text: "SQLite", link: "/drivers/sqlite" },
          { text: "PostgreSQL", link: "/drivers/postgres" },
        ],
      },
      {
        text: "Migrations",
        items: [{ text: "Overview", link: "/migrations/overview" }],
      },
      {
        text: "Reference",
        items: [
          { text: "API Reference", link: "/reference/api" },
          { text: "Architecture", link: "/reference/architecture" },
        ],
      },
    ],

    editLink: {
      pattern: "https://github.com/kalyvasio/typhex/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/kalyvasio/typhex" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present Ioannis Kalyvas",
    },
  },

  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
  },
});
