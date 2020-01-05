import fs from 'fs'
import path from 'path'
import ts from 'rollup-plugin-typescript2' //打印出ts的语法错误信息
import replace from '@rollup/plugin-replace' //打包时替换文件内的字符串
import json from '@rollup/plugin-json' //令 Rollup 从 JSON 文件中读取数据。

if (!process.env.TARGET) {
  throw new Error('TARGET package must be specified via --environment flag.')
}

const masterVersion = require('./package.json').version //package.json里的版本号
const packagesDir = path.resolve(__dirname, 'packages') //组合指向packages目录地址
const packageDir = path.resolve(packagesDir, process.env.TARGET) //指向packages目录下的process.env.TARGET目录
const name = path.basename(packageDir) //返回path的最后一部分，path.basename('/foo/bar/baz/asdf/quux.html');// 返回: 'quux.html'

const resolve = p => path.resolve(packageDir, p) //返回根据参数构造出的绝对路径地址
const pkg = require(resolve(`package.json`)) //引入packages目录下的process.env.TARGET包的package.json
const packageOptions = pkg.buildOptions || {} //获取该模块的打包选项

const knownExternals = fs.readdirSync(packagesDir).filter(p => {
  return p !== '@vue/shared'
})

// ensure TS checks only once for each build
let hasTSChecked = false

const outputConfigs = {
  'esm-bundler': {
    file: resolve(`dist/${name}.esm-bundler.js`),
    format: `es`
  },
  // main "vue" package only
  'esm-bundler-runtime': {
    file: resolve(`dist/${name}.runtime.esm-bundler.js`),
    format: `es`
  },
  cjs: {
    file: resolve(`dist/${name}.cjs.js`),
    format: `cjs`
  },
  global: {
    file: resolve(`dist/${name}.global.js`),
    format: `iife`
  },
  esm: {
    file: resolve(`dist/${name}.esm.js`),
    format: `es`
  }
}

const defaultFormats = ['esm-bundler', 'cjs'] //cjs指common js模块规范
const inlineFormats = process.env.FORMATS && process.env.FORMATS.split(',')
const packageFormats = inlineFormats || packageOptions.formats || defaultFormats
const packageConfigs = process.env.PROD_ONLY
  ? []
  : packageFormats.map(format => createConfig(format, outputConfigs[format]))

if (process.env.NODE_ENV === 'production') {
  packageFormats.forEach(format => {
    if (format === 'cjs' && packageOptions.prod !== false) {
      packageConfigs.push(createProductionConfig(format))
    }
    if (format === 'global' || format === 'esm') {
      packageConfigs.push(createMinifiedConfig(format))
    }
  })
}

export default packageConfigs

function createConfig(format, output, plugins = []) {
  if (!output) {
    console.log(require('chalk').yellow(`invalid format: "${format}"`))
    process.exit(1)
  }

  output.externalLiveBindings = false

  const isProductionBuild =
    process.env.__DEV__ === 'false' || /\.prod\.js$/.test(output.file)
  const isGlobalBuild = format === 'global'
  const isRawESMBuild = format === 'esm'
  const isBundlerESMBuild = /esm-bundler/.test(format)
  const isRuntimeCompileBuild = /vue\./.test(output.file)

  if (isGlobalBuild) {
    output.name = packageOptions.name
  }

  const shouldEmitDeclarations =
    process.env.TYPES != null &&
    process.env.NODE_ENV === 'production' &&
    !hasTSChecked

  const tsPlugin = ts({
    check: process.env.NODE_ENV === 'production' && !hasTSChecked,
    tsconfig: path.resolve(__dirname, 'tsconfig.json'),
    cacheRoot: path.resolve(__dirname, 'node_modules/.rts2_cache'),
    tsconfigOverride: {
      compilerOptions: {
        declaration: shouldEmitDeclarations,
        declarationMap: shouldEmitDeclarations
      },
      exclude: ['**/__tests__', 'test-dts']
    }
  })
  // we only need to check TS and generate declarations once for each build.
  // it also seems to run into weird issues when checking multiple times
  // during a single build.
  hasTSChecked = true

  const entryFile =
    format === 'esm-bundler-runtime' ? `src/runtime.ts` : `src/index.ts`

  return {
    input: resolve(entryFile),
    // Global and Browser ESM builds inlines everything so that they can be
    // used alone.
    external:
      isGlobalBuild || isRawESMBuild
        ? []
        : knownExternals.concat(Object.keys(pkg.dependencies || [])),
    plugins: [
      json({
        namedExports: false
      }),
      tsPlugin,
      createReplacePlugin(
        isProductionBuild,
        isBundlerESMBuild,
        (isGlobalBuild || isRawESMBuild || isBundlerESMBuild) &&
          !packageOptions.enableNonBrowserBranches,
        isRuntimeCompileBuild
      ),
      ...plugins
    ],
    output,
    onwarn: (msg, warn) => {
      if (!/Circular/.test(msg)) {
        warn(msg)
      }
    }
  }
}

function createReplacePlugin(
  isProduction,
  isBundlerESMBuild,
  isBrowserBuild,
  isRuntimeCompileBuild
) {
  const replacements = {
    __COMMIT__: `"${process.env.COMMIT}"`,
    __VERSION__: `"${masterVersion}"`,
    __DEV__: isBundlerESMBuild
      ? // preserve to be handled by bundlers
        `(process.env.NODE_ENV !== 'production')`
      : // hard coded dev/prod builds
        !isProduction,
    // this is only used during tests
    __TEST__: isBundlerESMBuild ? `(process.env.NODE_ENV === 'test')` : false,
    // If the build is expected to run directly in the browser (global / esm builds)
    __BROWSER__: isBrowserBuild,
    // is targeting bundlers?
    __BUNDLER__: isBundlerESMBuild,
    // support compile in browser?
    __RUNTIME_COMPILE__: isRuntimeCompileBuild,
    // support options?
    // the lean build drops options related code with buildOptions.lean: true
    __FEATURE_OPTIONS__: !packageOptions.lean && !process.env.LEAN,
    __FEATURE_SUSPENSE__: true
  }
  // allow inline overrides like
  //__RUNTIME_COMPILE__=true yarn build runtime-core
  Object.keys(replacements).forEach(key => {
    if (key in process.env) {
      replacements[key] = process.env[key]
    }
  })
  return replace(replacements)
}

function createProductionConfig(format) {
  return createConfig(format, {
    file: resolve(`dist/${name}.${format}.prod.js`),
    format: outputConfigs[format].format
  })
}

function createMinifiedConfig(format) {
  const { terser } = require('rollup-plugin-terser')
  return createConfig(
    format,
    {
      file: resolve(`dist/${name}.${format}.prod.js`),
      format: outputConfigs[format].format
    },
    [
      terser({
        module: /^esm/.test(format)
      })
    ]
  )
}
