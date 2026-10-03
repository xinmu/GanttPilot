# THIRD_PARTY NOTICES

> 本文件由 `pnpm notices:write`（`node scripts/check-licenses.mjs --all --write`）生成，**请勿手工编辑**。
> 本仓库自身以 MIT 发布；下列组件的许可与版权归其各自作者所有。
> 运行时依赖必须落在 `scripts/check-licenses.mjs` 的许可白名单内，这是 `pnpm gate` 的一环。

## 运行时依赖（随产物分发，白名单约束）

> 这些依赖会被打包/分发，因此许可必须落在白名单内。

共 24 个包。

- **@babel/helper-string-parser** `7.29.7` — MIT — https://babel.dev/docs/en/next/babel-helper-string-parser
- **@babel/helper-validator-identifier** `7.29.7` — MIT — https://github.com/babel/babel#readme
- **@babel/parser** `7.29.9` — MIT — https://babel.dev/docs/en/next/babel-parser
- **@babel/types** `7.29.8` — MIT — https://babel.dev/docs/en/next/babel-types
- **@jridgewell/sourcemap-codec** `1.6.0` — MIT — https://github.com/jridgewell/sourcemaps/tree/main/packages/sourcemap-codec
- **@vue/compiler-core** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/compiler-core#readme
- **@vue/compiler-dom** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/compiler-dom#readme
- **@vue/compiler-sfc** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/compiler-sfc#readme
- **@vue/compiler-ssr** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/compiler-ssr#readme
- **@vue/reactivity** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/reactivity#readme
- **@vue/runtime-core** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/runtime-core#readme
- **@vue/runtime-dom** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/runtime-dom#readme
- **@vue/server-renderer** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/server-renderer#readme
- **@vue/shared** `3.5.43` — MIT — https://github.com/vuejs/core/tree/main/packages/shared#readme
- **csstype** `3.2.3` — MIT — https://github.com/frenic/csstype#readme
- **entities** `7.0.1` — BSD-2-Clause — https://github.com/fb55/entities#readme
- **estree-walker** `2.0.2` — MIT — https://github.com/Rich-Harris/estree-walker#readme
- **magic-string** `0.30.21` — MIT — https://github.com/Rich-Harris/magic-string#readme
- **nanoid** `3.3.19` — MIT — https://github.com/ai/nanoid#readme
- **picocolors** `1.1.1` — ISC — https://github.com/alexeyraspopov/picocolors#readme
- **postcss** `8.5.28` — MIT — https://postcss.org/
- **source-map-js** `1.2.2` — BSD-3-Clause — https://github.com/7rulnik/source-map-js
- **typescript** `5.9.3` — Apache-2.0 — https://www.typescriptlang.org/
- **vue** `3.5.43` — MIT — https://vuejs.org/

## 开发依赖（不随产物分发，仅构建与测试）

> 列出它们是为了在 PR 阶段就暴露许可异常；其中 MPL-2.0 / BlueOak-1.0.0 属于已知例外，见脚本内注释。

共 137 个包。

- **@cacheable/memory** `2.2.0` — MIT — https://github.com/jaredwray/cacheable#readme
- **@cacheable/utils** `2.5.0` — MIT — https://github.com/jaredwray/cacheable#readme
- **@eslint-community/eslint-utils** `4.10.1` — MIT — https://github.com/eslint-community/eslint-utils#readme
- **@eslint-community/regexpp** `4.12.2` — MIT — https://github.com/eslint-community/regexpp#readme
- **@eslint/config-array** `0.23.5` — Apache-2.0 — https://github.com/eslint/rewrite/tree/main/packages/config-array#readme
- **@eslint/config-helpers** `0.7.0` — Apache-2.0 — https://github.com/eslint/rewrite/tree/main/packages/config-helpers#readme
- **@eslint/core** `1.2.1` — Apache-2.0 — https://github.com/eslint/rewrite/tree/main/packages/core#readme
- **@eslint/js** `10.0.1` — MIT — https://eslint.org
- **@eslint/object-schema** `3.0.5` — Apache-2.0 — https://github.com/eslint/rewrite/tree/main/packages/object-schema#readme
- **@eslint/plugin-kit** `0.7.3` — Apache-2.0 — https://github.com/eslint/rewrite/tree/main/packages/plugin-kit#readme
- **@humanfs/core** `0.19.2` — Apache-2.0 — https://github.com/humanwhocodes/humanfs#readme
- **@humanfs/node** `0.16.8` — Apache-2.0 — https://github.com/humanwhocodes/humanfs#readme
- **@humanfs/types** `0.15.0` — Apache-2.0 — https://github.com/humanwhocodes/humanfs#readme
- **@humanwhocodes/module-importer** `1.0.1` — Apache-2.0 — https://github.com/humanwhocodes/module-importer#readme
- **@humanwhocodes/retry** `0.4.3` — Apache-2.0 — https://github.com/humanwhocodes/retry#readme
- **@jridgewell/resolve-uri** `3.1.2` — MIT — https://github.com/jridgewell/resolve-uri#readme
- **@jridgewell/trace-mapping** `0.3.31` — MIT — https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping
- **@keyv/bigmap** `1.3.1` — MIT — https://github.com/jaredwray/keyv
- **@keyv/serialize** `1.1.1` — MIT — https://github.com/jaredwray/keyv
- **@oxc-project/types** `0.152.0` — MIT — https://oxc.rs
- **@rolldown/binding-win32-x64-msvc** `1.2.12` — MIT — https://rolldown.rs/
- **@rolldown/pluginutils** `1.0.1` — MIT — https://github.com/rolldown/plugins/tree/main/packages/pluginutils#readme
- **@types/chai** `5.2.3` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/chai
- **@types/deep-eql** `4.0.2` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/deep-eql
- **@types/esrecurse** `4.3.1` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/esrecurse
- **@types/estree** `1.0.9` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/estree
- **@types/json-schema** `7.0.15` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/json-schema
- **@types/node** `24.19.1` — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node
- **@typescript-eslint/eslint-plugin** `8.71.0` — MIT — https://typescript-eslint.io/packages/eslint-plugin
- **@typescript-eslint/parser** `8.71.0` — MIT — https://typescript-eslint.io/packages/parser
- **@typescript-eslint/project-service** `8.71.0` — MIT — https://typescript-eslint.io
- **@typescript-eslint/scope-manager** `8.71.0` — MIT — https://typescript-eslint.io/packages/scope-manager
- **@typescript-eslint/tsconfig-utils** `8.71.0` — MIT — https://typescript-eslint.io
- **@typescript-eslint/type-utils** `8.71.0` — MIT — https://typescript-eslint.io
- **@typescript-eslint/types** `8.71.0` — MIT — https://typescript-eslint.io
- **@typescript-eslint/typescript-estree** `8.71.0` — MIT — https://typescript-eslint.io/packages/typescript-estree
- **@typescript-eslint/utils** `8.71.0` — MIT — https://typescript-eslint.io/packages/utils
- **@typescript-eslint/visitor-keys** `8.71.0` — MIT — https://typescript-eslint.io
- **@vitejs/plugin-vue** `6.0.9` — MIT — https://github.com/vitejs/vite-plugin-vue/tree/main/packages/plugin-vue#readme
- **@vitest/mocker** `5.0.3` — MIT — https://github.com/vitest-dev/vitest/tree/main/packages/mocker
- **@vitest/spy** `5.0.3` — MIT — https://vitest.dev/api/mock
- **@volar/language-core** `2.4.28` — MIT — https://github.com/volarjs/volar.js#readme
- **@volar/source-map** `2.4.28` — MIT — https://github.com/volarjs/volar.js#readme
- **@volar/typescript** `2.4.28` — MIT — https://github.com/volarjs/volar.js#readme
- **@vue/language-core** `3.3.12` — MIT — https://github.com/vuejs/language-tools#readme
- **acorn** `8.18.0` — MIT — https://github.com/acornjs/acorn
- **acorn-jsx** `5.3.2` — MIT — https://github.com/acornjs/acorn-jsx
- **ajv** `6.15.0` — MIT — https://github.com/ajv-validator/ajv
- **alien-signals** `3.2.1` — MIT — https://github.com/stackblitz/alien-signals#readme
- **assertion-error** `2.0.1` — MIT — https://github.com/chaijs/assertion-error#readme
- **balanced-match** `4.0.4` — MIT — https://github.com/juliangruber/balanced-match#readme
- **boolbase** `1.0.0` — ISC — https://github.com/fb55/boolbase
- **brace-expansion** `5.0.12` — MIT — https://github.com/juliangruber/brace-expansion#readme
- **cacheable** `2.5.0` — MIT — https://github.com/jaredwray/cacheable#readme
- **chai** `6.3.0` — MIT — http://chaijs.com
- **cross-spawn** `7.0.6` — MIT — https://github.com/moxystudio/node-cross-spawn
- **cssesc** `3.0.0` — MIT — https://mths.be/cssesc
- **debug** `4.4.3` — MIT — https://github.com/debug-js/debug#readme
- **deep-is** `0.1.4` — MIT — https://github.com/thlorenz/deep-is#readme
- **detect-libc** `2.1.2` — Apache-2.0 — https://github.com/lovell/detect-libc#readme
- **es-module-lexer** `2.3.2` — MIT — https://github.com/guybedford/es-module-lexer#readme
- **escape-string-regexp** `4.0.0` — MIT — https://github.com/sindresorhus/escape-string-regexp#readme
- **eslint** `10.12.0` — MIT — https://eslint.org
- **eslint-plugin-vue** `10.11.1` — MIT — https://eslint.vuejs.org
- **eslint-scope** `9.1.2` — BSD-2-Clause — https://github.com/eslint/js/blob/main/packages/eslint-scope/README.md
- **eslint-visitor-keys** `3.4.3, 5.0.1` — Apache-2.0 — https://github.com/eslint/js/blob/main/packages/eslint-visitor-keys/README.md
- **espree** `11.2.0` — BSD-2-Clause — https://github.com/eslint/js/blob/main/packages/espree/README.md
- **esquery** `1.7.0` — BSD-3-Clause — https://github.com/estools/esquery/
- **esrecurse** `4.3.0` — BSD-2-Clause — https://github.com/estools/esrecurse
- **estraverse** `5.3.0` — BSD-2-Clause — https://github.com/estools/estraverse
- **esutils** `2.0.3` — BSD-2-Clause — https://github.com/estools/esutils
- **expect-type** `1.4.0` — Apache-2.0 — https://github.com/mmkal/expect-type#readme
- **fast-deep-equal** `3.1.3` — MIT — https://github.com/epoberezkin/fast-deep-equal#readme
- **fast-json-stable-stringify** `2.1.0` — MIT — https://github.com/epoberezkin/fast-json-stable-stringify
- **fast-levenshtein** `2.0.6` — MIT — https://github.com/hiddentao/fast-levenshtein#readme
- **fdir** `6.5.0` — MIT — https://github.com/thecodrr/fdir#readme
- **file-entry-cache** `11.1.5` — MIT — https://github.com/jaredwray/cacheable#readme
- **find-up** `5.0.0` — MIT — https://github.com/sindresorhus/find-up#readme
- **flat-cache** `6.1.23` — MIT — https://github.com/jaredwray/cacheable#readme
- **flatted** `3.4.4` — ISC — https://github.com/WebReflection/flatted#readme
- **glob-parent** `6.0.2` — ISC — https://github.com/gulpjs/glob-parent#readme
- **hashery** `1.5.1` — MIT — https://github.com/jaredwray/hashery#readme
- **hookified** `1.15.1, 2.2.0` — MIT — https://github.com/jaredwray/hookified#readme
- **husky** `9.1.7` — MIT — https://github.com/typicode/husky#readme
- **ignore** `5.3.2, 7.0.12` — MIT — https://github.com/kaelzhang/node-ignore#readme
- **imurmurhash** `0.1.4` — MIT — https://github.com/jensyt/imurmurhash-js
- **is-extglob** `2.1.1` — MIT — https://github.com/jonschlinkert/is-extglob
- **is-glob** `4.0.3` — MIT — https://github.com/micromatch/is-glob
- **isexe** `2.0.0` — ISC — https://github.com/isaacs/isexe#readme
- **json-schema-traverse** `0.4.1` — MIT — https://github.com/epoberezkin/json-schema-traverse#readme
- **json-stable-stringify-without-jsonify** `1.0.1` — MIT — https://github.com/samn/json-stable-stringify
- **keyv** `5.6.0` — MIT — https://github.com/jaredwray/keyv
- **levn** `0.4.1` — MIT — https://github.com/gkz/levn
- **lightningcss** `1.33.0` — MPL-2.0 — https://github.com/parcel-bundler/lightningcss#readme
- **lightningcss-win32-x64-msvc** `1.33.0` — MPL-2.0 — https://github.com/parcel-bundler/lightningcss#readme
- **locate-path** `6.0.0` — MIT — https://github.com/sindresorhus/locate-path#readme
- **minimatch** `10.2.6` — BlueOak-1.0.0 — https://github.com/isaacs/minimatch#readme
- **ms** `2.1.3` — MIT — https://github.com/vercel/ms#readme
- **muggle-string** `0.4.1` — MIT — https://github.com/johnsoncodehk/muggle-string#readme
- **natural-compare** `1.4.0` — MIT — https://github.com/litejs/natural-compare-lite#readme
- **nth-check** `2.1.1` — BSD-2-Clause — https://github.com/fb55/nth-check
- **obug** `2.2.1` — MIT — https://github.com/sxzz/obug#readme
- **optionator** `0.9.4` — MIT — https://github.com/gkz/optionator
- **p-limit** `3.1.0` — MIT — https://github.com/sindresorhus/p-limit#readme
- **p-locate** `5.0.0` — MIT — https://github.com/sindresorhus/p-locate#readme
- **path-browserify** `1.0.1` — MIT — https://github.com/browserify/path-browserify
- **path-exists** `4.0.0` — MIT — https://github.com/sindresorhus/path-exists#readme
- **path-key** `3.1.1` — MIT — https://github.com/sindresorhus/path-key#readme
- **picomatch** `4.0.7` — MIT — https://github.com/micromatch/picomatch
- **postcss-selector-parser** `7.1.6` — MIT — https://github.com/postcss/postcss-selector-parser
- **prelude-ls** `1.2.1` — MIT — http://preludels.com
- **punycode** `2.3.1` — MIT — https://mths.be/punycode
- **qified** `0.10.1` — MIT — https://github.com/jaredwray/qified#readme
- **rolldown** `1.2.12` — MIT — https://rolldown.rs/
- **semver** `7.8.5` — ISC — https://github.com/npm/node-semver#readme
- **shebang-command** `2.0.0` — MIT — https://github.com/kevva/shebang-command#readme
- **shebang-regex** `3.0.0` — MIT — https://github.com/sindresorhus/shebang-regex#readme
- **std-env** `4.3.0` — MIT — https://github.com/unjs/std-env#readme
- **tinybench** `6.2.0` — MIT — https://github.com/tinylibs/tinybench#readme
- **tinyexec** `1.3.1` — MIT — https://github.com/tinylibs/tinyexec#readme
- **tinyglobby** `0.2.17` — MIT — https://superchupu.dev/tinyglobby
- **ts-api-utils** `2.5.0` — MIT — https://github.com/JoshuaKGoldberg/ts-api-utils#readme
- **type-check** `0.4.0` — MIT — https://github.com/gkz/type-check
- **typescript-eslint** `8.71.0` — MIT — https://typescript-eslint.io/packages/typescript-eslint
- **undici-types** `7.24.6` — MIT — https://undici.nodejs.org
- **uri-js** `4.4.1` — BSD-2-Clause — https://github.com/garycourt/uri-js
- **util-deprecate** `1.0.2` — MIT — https://github.com/TooTallNate/util-deprecate
- **vite** `8.3.2` — MIT — https://vite.dev
- **vitest** `5.0.3` — MIT — https://vitest.dev
- **vscode-uri** `3.2.0` — MIT — https://github.com/microsoft/vscode-uri#readme
- **vue-eslint-parser** `10.4.1` — MIT — https://github.com/vuejs/vue-eslint-parser#readme
- **vue-tsc** `3.3.12` — MIT — https://github.com/vuejs/language-tools#readme
- **which** `2.0.2` — ISC — https://github.com/isaacs/node-which#readme
- **why-is-node-running** `3.2.1` — MIT — https://github.com/mafintosh/why-is-node-running
- **word-wrap** `1.2.5` — MIT — https://github.com/jonschlinkert/word-wrap
- **xml-name-validator** `5.0.0` — Apache-2.0 — https://github.com/jsdom/xml-name-validator#readme
- **yocto-queue** `0.1.0` — MIT — https://github.com/sindresorhus/yocto-queue#readme
