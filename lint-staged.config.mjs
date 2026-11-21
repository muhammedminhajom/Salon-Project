const config = {
  "*.{js,jsx,cjs,mjs,ts,tsx,mts,cts}": ["eslint --fix --max-warnings=0", "prettier --write"],
  "*.{css,html,json,jsonc,md,mdx,scss,yaml,yml}": "prettier --write",
};

export default config;
