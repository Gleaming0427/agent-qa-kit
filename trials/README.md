# Trial applications

`omni-tools/` is a copy of [omni-tools](https://github.com/iib0011/omni-tools) at commit 9244e02 (24 October 2026), MIT license (`omni-tools/LICENSE`), used to try the Agent QA Kit on a real application. It is not the omni-tools project: use and contribute to the original.

Changed for the kit, nothing else:

- `playwright.config.ts`: Playwright also runs `e2e/`, where the QA agents write their tests, and only Chromium, which the kit's workflows install;
- `package.json`: the scripts the kit calls (`test:unit`, `test:affected`, `test:e2e`, `test:summary`), with their JSON reports;
- `.gitignore`: `/reports/`;
- the "join" tool's browser test is tagged `@smoke`, the journey QA verify's full suite requires.

Its `.github/` and `.husky/` folders were left out.
