import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // eslint-config-next 16.3 enables the React Compiler lint rules, which
    // flag the long-standing "fetch in useEffect + setState" data-loading
    // pattern used across pages. Adopting the compiler rules is a separate
    // refactor (TODO); keep them visible as warnings, not build-breaking.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
    },
  },
  {
    // lightweight-charts integration predates strict typing here; the chart
    // refs/series plumbing still uses `any` (TODO: type with IChartApi /
    // ISeriesApi). Confine the relaxation to the two chart components.
    files: ["src/components/trade/Chart.tsx", "src/components/trade/FundingChart.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
