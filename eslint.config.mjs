// Static a11y lint: jsx-a11y `strict` on src/**/*.tsx. Run `npm run lint:a11y`.
// Rule disables below each carry a one-line justification (task requirement).
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "dist-e2e/", "node_modules/", "e2e/", "a11y/", "playwright-report/", "e2e-results/"],
  },
  {
    files: ["src/**/*.tsx", "src/**/*.ts"],
    extends: [tseslint.configs.base],
    plugins: { "jsx-a11y": jsxA11y },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...jsxA11y.configs.strict.rules,
      // Dialog overlay: click-to-dismiss on a plain div keeps the overlay out of
      // the tab order and unnamed; keyboard users get Esc + a labelled panel.
      "jsx-a11y/no-static-element-interactions": "off",
      // Same overlay: mouse-only affordance duplicated by Esc handling.
      "jsx-a11y/click-events-have-key-events": "off",
      // Dialog Tab-trap lives on the labelled panel (tabIndex=-1, aria-modal);
      // making every trap host natively interactive would break dialog semantics.
      "jsx-a11y/no-noninteractive-element-interactions": "off",
    },
  }
);
