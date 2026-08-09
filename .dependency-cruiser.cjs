/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-source-dependencies",
      severity: "error",
      from: { path: "^(apps|packages)" },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: "(^|/)(dist|node_modules|target)/|\\.test\\.ts$",
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "node", "default"],
      exportsFields: ["exports"],
    },
  },
};
