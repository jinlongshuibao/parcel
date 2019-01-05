const Asset = require('../Asset');
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');
const postcssTransform = require('../transforms/postcss');
const CssSyntaxError = require('postcss/lib/css-syntax-error');
const SourceMap = require('../SourceMap');
const loadSourceMap = require('../utils/loadSourceMap');

const URL_RE = /url\s*\("?(?![a-z]+:)/;
const IMPORT_RE = /@import/;
const PROTOCOL_RE = /^[a-z]+:/;

async function sourceMapReplaceOrExtend(extension, base) {
  if (base) {
    return await new SourceMap().extendSourceMap(extension, base);
  } else {
    return await new SourceMap().addMap(extension);
  }
}

class CSSAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'css';
    this.sourceMapFromPipeline = this.options.rendition
      ? this.options.rendition.map
      : null;
  }

  mightHaveDependencies() {
    return (
      !/\.css$/.test(this.name) ||
      IMPORT_RE.test(this.contents) ||
      URL_RE.test(this.contents)
    );
  }

  parse(code) {
    let root = postcss.parse(code, {
      from: this.name
    });
    return new CSSAst(code, root);
  }

  collectDependencies() {
    this.ast.root.walkAtRules('import', rule => {
      let params = valueParser(rule.params);
      let [name, ...media] = params.nodes;
      let dep;
      if (
        name.type === 'function' &&
        name.value === 'url' &&
        name.nodes.length
      ) {
        name = name.nodes[0];
      }

      dep = name.value;

      if (!dep) {
        throw new Error('Could not find import name for ' + rule);
      }

      if (PROTOCOL_RE.test(dep)) {
        return;
      }

      // If this came from an inline <style> tag, don't inline the imported file. Replace with the correct URL instead.
      // TODO: run CSSPackager on inline style tags.
      let inlineHTML =
        this.options.rendition && this.options.rendition.inlineHTML;
      if (inlineHTML) {
        name.value = this.addURLDependency(dep, {loc: rule.source.start});
        rule.params = params.toString();
      } else {
        media = valueParser.stringify(media).trim();
        this.addDependency(dep, {media, loc: rule.source.start});
        rule.remove();
      }

      this.ast.dirty = true;
    });

    this.ast.root.walkDecls(decl => {
      if (URL_RE.test(decl.value)) {
        let parsed = valueParser(decl.value);
        let dirty = false;

        parsed.walk(node => {
          if (
            node.type === 'function' &&
            node.value === 'url' &&
            node.nodes.length
          ) {
            let url = this.addURLDependency(node.nodes[0].value, {
              loc: decl.source.start
            });
            dirty = node.nodes[0].value !== url;
            node.nodes[0].value = url;
          }
        });

        if (dirty) {
          decl.value = parsed.toString();
          this.ast.dirty = true;
        }
      }
    });
  }

  async pretransform() {
    if (this.options.sourceMaps) {
      this.sourceMapExisting = await loadSourceMap(this);
    }
  }

  async transform() {
    await postcssTransform(this);
  }

  getCSSAst() {
    // Converts the ast to a CSS ast if needed, so we can apply postcss transforms.
    if (!(this.ast instanceof CSSAst)) {
      this.ast = CSSAsset.prototype.parse.call(
        this,
        this.ast.render(this.name)
      );
    }

    return this.ast.root;
  }

  async generate() {
    let css;
    if (this.ast) {
      let result = this.ast.render(this.name);
      css = result.css;
      if (result.map) this.sourceMap = result.map;
    } else {
      css = this.contents;
    }

    let js = '';
    if (this.options.hmr) {
      this.addDependency('_css_loader');

      js = `
        var reloadCSS = require('_css_loader');
        module.hot.dispose(reloadCSS);
        module.hot.accept(reloadCSS);
      `;
    }

    if (this.cssModules) {
      js +=
        'module.exports = ' + JSON.stringify(this.cssModules, null, 2) + ';';
    }

    let map;
    if (this.options.sourceMaps) {
      if (this.sourceMap) {
        if (this.sourceMap instanceof SourceMap) {
          map = this.sourceMap;
        } else {
          map = await new SourceMap().addMap(this.sourceMap);

          if (this.sourceMap.toJSON) {
            // a SourceMapGenerator, PostCSS's sourcemaps contain invalid entries
            let sourceLines = {};
            for (let [path, content] of Object.entries(map.sources)) {
              sourceLines[path] = content.split('\n');
            }

            map.mappings = map.mappings.filter(
              ({source, original: {line, column}}) =>
                line - 1 < sourceLines[source].length &&
                column < sourceLines[source][line - 1].length
            );
          }
        }
      }

      if (this.sourceMapFromPipeline) {
        map = await sourceMapReplaceOrExtend(this.sourceMapFromPipeline, map);
      }

      if (this.sourceMapExisting) {
        map = await sourceMapReplaceOrExtend(this.sourceMapExisting, map);
      }

      if (!map) {
        map = new SourceMap().generateEmptyMap(this.relativeName, css);
      }
    }

    return [
      {
        type: 'css',
        value: css,
        cssModules: this.cssModules
      },
      {
        type: 'js',
        value: js,
        hasDependencies: false
      },
      {
        type: 'map',
        value: map
      }
    ];
  }

  generateErrorMessage(err) {
    // Wrap the error in a CssSyntaxError if needed so we can generate a code frame
    if (err.loc && !err.showSourceCode) {
      err = new CssSyntaxError(
        err.message,
        err.loc.line,
        err.loc.column,
        this.contents
      );
    }

    err.message = err.reason || err.message;
    err.loc = {
      line: err.line,
      column: err.column
    };

    if (err.showSourceCode) {
      err.codeFrame = err.showSourceCode();
      err.highlightedCodeFrame = err.showSourceCode(true);
    }

    return err;
  }
}

class CSSAst {
  constructor(css, root) {
    this.css = css;
    this.root = root;
    this.dirty = false;
  }

  render(name) {
    if (this.dirty) {
      let {css, map} = this.root.toResult({
        to: name,
        map: {inline: false, annotation: false, sourcesContent: true}
      });

      this.css = css;

      return {
        css: this.css,
        map
      };
    }

    return {
      css: this.css
    };
  }
}

module.exports = CSSAsset;
