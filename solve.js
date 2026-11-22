const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const own = Object.hasOwn;
const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escape = text => text.replace(/[&<>"']/g, ch => entities[ch]);
function trimLine(text) {
  let start = 0, end = text.length;
  while (text[start] === ' ' || text[start] === '\t') start++;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(start, end);
}
const slugify = text => text.normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
  .replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'untitled';

function unique(slug, used) {
  let result = slug;
  for (let i = 2; used.has(result); i++) result = slug + '-' + i;
  used.add(result);
  return result;
}

const fields = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const months = 'January February March April May June July August September October November December'.split(' ');
function validDate(value) {
  if (!/^(?:19[7-9]\d|20\d\d)-\d\d-\d\d$/.test(value)) return false;
  const month = +value.slice(5, 7), day = +value.slice(8);
  const year = +value.slice(0, 4);
  const february = year % 4 === 0 ? 29 : 28;
  return day >= 1 && day <= [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function frontMatter(lines) {
  if (lines[0] !== '---') return {error: 'no front matter'};
  const end = lines.indexOf('---', 1);
  if (end < 0) return {error: 'the front matter is not closed'};
  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (blank.test(line) || line[0] === '#') continue;
    const match = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!match) return {error: 'line ' + (i + 1) + ' is not "key: value"'};
    let [, key, value = ''] = match;
    value = value.replace(/[ \t]+$/, '');
    if (!fields.has(key)) return {error: 'unknown key "' + key + '"'};
    if (own(data, key)) return {error: 'key "' + key + '" is given twice'};
    if (!value) return {error: 'key "' + key + '" has no value'};
    let error;
    switch (key) {
      case 'title':
      case 'summary':
        if (value[0] === '[') error = 'a bare string opens on [';
        if (value[0] === '"') {
          if (value.length < 2 || !value.endsWith('"')) error = 'a quoted string is not closed';
          else {
            value = value.slice(1, -1).replace(/\\([\s\S]|$)|"/g, (token, next) => {
              if (next === '"' || next === '\\') return next;
              error ||= token === '"' ? 'a quoted string holds a stray quote' :
                'a quoted string holds an escape other than \\" or \\\\';
              return token;
            });
          }
        }
        break;
      case 'date':
        if (!validDate(value)) error = 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
        break;
      case 'tags':
        if (!value.startsWith('[') || !value.endsWith(']')) error = 'not a list [a, b]';
        else {
          value = value.slice(1, -1).trim() === '' ? [] : value.slice(1, -1).split(',').map(name => name.trim());
          if (value.some(name => !name || /["\[\]]/.test(name))) error = 'an empty tag, or one holding " [ or ]';
        }
        break;
      case 'draft':
        if (value !== 'true' && value !== 'false') error = 'true or false';
        value = value === 'true';
        break;
      case 'layout':
        if (!/^[a-z0-9-]+$/.test(value)) error = 'not a template name';
        break;
      case 'slug':
        if (value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) error = 'not a slug';
        break;
    }
    if (error) return {error: 'key "' + key + '": ' + error};
    data[key] = value;
  }
  if (!own(data, 'title')) return {error: 'no title'};
  return {data, end};
}

const pathPattern = /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/;
function parseTemplate(source) {
  const root = [], stack = [];
  let nodes = root, literalStart = 0;
  const openers = /\{\{\{|\{\{|\{%/g;
  for (let match; (match = openers.exec(source));) {
    const start = match.index, opener = match[0];
    const closing = opener === '{%' ? '%}' : opener === '{{' ? '}}' : '}}}';
    const end = source.indexOf(closing, openers.lastIndex);
    if (end < 0) throw 'a ' + opener + ' is not closed';
    const inner = source.slice(openers.lastIndex, end).trim();
    let textEnd = start;
    let offset = end + closing.length;
    if (opener === '{%') {
      const lineStart = source.lastIndexOf('\n', start - 1) + 1;
      let lineEnd = source.indexOf('\n', offset);
      if (lineEnd < 0) lineEnd = source.length;
      if (/^[ \t]*$/.test(source.slice(lineStart, start)) &&
          /^[ \t]*$/.test(source.slice(offset, lineEnd))) {
        textEnd = lineStart;
        offset = Math.min(lineEnd + 1, source.length);
      }
    }
    if (textEnd > literalStart) nodes.push(source.slice(literalStart, textEnd));
    literalStart = offset;
    openers.lastIndex = offset;
    if (opener !== '{%') {
      if (!pathPattern.test(inner)) throw '"' + inner + '" is not a path';
      nodes.push({kind: opener === '{{' ? 'escaped' : 'raw', path: inner.split('.')});
      continue;
    }
    let parts, node;
    const frame = stack.at(-1);
    if ((parts = /^include +"([a-z0-9-]+)"$/.exec(inner))) {
      nodes.push({kind: 'include', name: parts[1]});
    } else if ((parts = /^for +([a-zA-Z_]\w*) +in +(.+)$/.exec(inner))) {
      if (!pathPattern.test(parts[2])) throw '"' + parts[2] + '" is not a path';
      node = {kind: 'for', name: parts[1], path: parts[2].split('.'), body: []};
    } else if ((parts = /^if +(?:(not) +)?(.+)$/.exec(inner))) {
      if (!pathPattern.test(parts[2])) throw '"' + parts[2] + '" is not a path';
      node = {kind: 'if', negate: Boolean(parts[1]), path: parts[2].split('.'), body: [], alternate: null};
    } else if (inner === 'else') {
      if (frame?.node.kind !== 'if' || frame.node.alternate) throw 'an else outside an if';
      nodes = frame.node.alternate = [];
    } else if (inner === 'endif' || inner === 'endfor') {
      const kind = inner.slice(3);
      if (frame?.node.kind !== kind) throw 'an ' + inner + ' with no open ' + kind;
      nodes = stack.pop().parent;
    } else throw '{% ' + inner + ' %} is not a tag';
    if (node) {
      nodes.push(node);
      stack.push({node, parent: nodes});
      nodes = node.body;
    }
  }
  if (stack.length) throw 'a ' + stack.at(-1).node.kind + ' is not closed';
  if (literalStart < source.length) root.push(source.slice(literalStart));
  return root;
}

function lookup(path, scope, loop) {
  const name = path[0];
  let value;
  while (loop) {
    if (name === 'loop') { value = loop.state; break; }
    if (name === loop.name) { value = loop.item; break; }
    loop = loop.parent;
  }
  if (!loop && own(scope, name)) value = scope[name];
  for (let i = 1; i < path.length; i++) {
    if (value === null || typeof value !== 'object' || !own(value, path[i])) return undefined;
    value = value[path[i]];
  }
  return value;
}

function display(value) {
  switch (typeof value) {
    case 'string': return value;
    case 'number':
    case 'boolean': return String(value);
    default: return Array.isArray(value) ? value.map(display).join(', ') : '';
  }
}

function render(nodes, scope, templates, loop = null, depth = 0) {
  let html = '';
  for (const node of nodes) {
    if (typeof node === 'string') { html += node; continue; }
    if (node.kind === 'include') {
      const included = templates.get(node.name);
      if (included && depth < 8) html += render(included, scope, templates, loop, depth + 1);
      continue;
    }
    const value = lookup(node.path, scope, loop);
    switch (node.kind) {
      case 'raw': html += display(value); break;
      case 'escaped': html += escape(display(value)); break;
      case 'if': {
        const truth = Array.isArray(value) ? value.length !== 0 : Boolean(value);
        const branch = truth !== node.negate ? node.body : node.alternate;
        if (branch) html += render(branch, scope, templates, loop, depth);
        break;
      }
      case 'for':
        if (Array.isArray(value)) {
          const state = {index: 0, length: value.length, first: true, last: false};
          const frame = {name: node.name, item: null, state, parent: loop};
          for (let i = 0; i < value.length; i++) {
            frame.item = value[i];
            state.index = i + 1;
            state.first = i === 0;
            state.last = state.index === state.length;
            html += render(node.body, scope, templates, frame, depth);
          }
        }
        break;
    }
  }
  return html;
}

const punctuation = "\\`*_[]()#+-.!>";
function closingAt(text, token, start, single = false) {
  for (let at = start; at < text.length; at++) {
    if (text[at] === '\\' && punctuation.includes(text[at + 1])) { at++; continue; }
    if (single && text[at] === '*' && text[at + 1] === '*') { at++; continue; }
    if (text.startsWith(token, at)) return at;
  }
  return -1;
}

function inline(text, href) {
  const specials = /[\\`*\[&<>"']/g;
  let result = '', offset = 0;
  for (let match; (match = specials.exec(text));) {
    const at = match.index, token = match[0];
    result += text.slice(offset, at);
    offset = at + 1;
    if (token === '\\' && punctuation.includes(text[offset])) {
      result += escape(text[offset++]);
    } else if (token === '`') {
      const end = text.indexOf('`', offset);
      if (end > offset) {
        result += '<code>' + escape(text.slice(offset, end)) + '</code>';
        offset = end + 1;
      } else result += token;
    } else if (token === '*') {
      const strong = text[offset] === '*';
      if (strong) offset++;
      const delimiter = strong ? '**' : '*';
      const end = closingAt(text, delimiter, offset, !strong);
      if (end > offset) {
        const tag = delimiter === '**' ? 'strong' : 'em';
        result += '<' + tag + '>' + inline(text.slice(offset, end), href) + '</' + tag + '>';
        offset = end + delimiter.length;
      } else result += delimiter;
    } else if (token === '[') {
      const bracket = closingAt(text, ']', offset);
      const end = bracket >= 0 && text[bracket + 1] === '(' ? text.indexOf(')', bracket + 2) : -1;
      if (end > bracket + 2) {
        const target = text.slice(bracket + 2, end);
        if (!/\s/.test(target)) {
          const resolved = escape(href(target));
          result += '<a href="' + resolved + '">' + inline(text.slice(offset, bracket), href) + '</a>';
          offset = end + 1;
        } else result += token;
      } else result += token;
    } else result += entities[token] ?? token;
    specials.lastIndex = offset;
  }
  return result + text.slice(offset);
}

const fence = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const fenceEnd = /^```[ \t]*$/;
const heading = /^(#{1,6})[ \t]+([^ \t].*?)[ \t]*$/;
const rule = /^(?:---|\*\*\*)[ \t]*$/;
const bullet = /^[-*] (.*)$/;
const ordered = /^(\d{1,9})\. (.*)$/;
const continuation = /^ {2,}\S/;
const blank = /^[ \t]*$/;
function interruptsParagraph(line) {
  switch (line[0]) {
    case undefined: return true;
    case ' ':
    case '\t': return blank.test(line);
    case '`': return fence.test(line);
    case '#': return heading.test(line);
    case '-':
    case '*': return rule.test(line);
    default: return false;
  }
}
function markdown(lines, start, href) {
  let content = '', excerpt = '';
  let firstParagraph = true;
  const toc = [], ids = new Set();
  for (let i = start; i < lines.length;) {
    const line = lines[i++];
    if (blank.test(line)) continue;
    let match;
    if ((match = fence.exec(line))) {
      content += '<pre><code' + (match[1] ? ' class="language-' + match[1] + '"' : '') + '>';
      while (i < lines.length && !fenceEnd.test(lines[i])) content += escape(lines[i++]) + '\n';
      if (i < lines.length) i++;
      content += '</code></pre>\n';
    } else if ((match = heading.exec(line))) {
      const level = match[1].length, id = unique(slugify(match[2]), ids), html = inline(match[2], href);
      content += '<h' + level + ' id="' + id + '">' + html + '</h' + level + '>\n';
      if (level === 2 || level === 3) toc.push({level, id, html});
    } else if (rule.test(line)) {
      content += '<hr>\n';
    } else if (line[0] === '>') {
      const quote = [];
      let next = line;
      do {
        const trimmed = trimLine(next.slice(1));
        if (trimmed) quote.push(trimmed);
        next = lines[i];
        if (next?.[0] !== '>') break;
        i++;
      } while (true);
      content += '<blockquote>\n';
      if (quote.length) content += '<p>' + inline(quote.join('\n'), href) + '</p>\n';
      content += '</blockquote>\n';
    } else if ((match = bullet.exec(line) || ordered.exec(line))) {
      const isOrdered = match.length === 3, tag = isOrdered ? 'ol' : 'ul';
      const number = isOrdered ? Number(match[1]) : 1;
      const pattern = isOrdered ? ordered : bullet;
      const itemIndex = match.length - 1;
      content += '<' + tag + (number === 1 ? '' : ' start="' + number + '"') + '>\n';
      do {
        let item = trimLine(match[itemIndex]);
        while (i < lines.length && continuation.test(lines[i])) item += '\n' + trimLine(lines[i++]);
        content += '<li>' + inline(item, href) + '</li>\n';
        match = i < lines.length ? pattern.exec(lines[i]) : null;
        if (match) i++;
      } while (match);
      content += '</' + tag + '>\n';
    } else {
      let paragraph = trimLine(line);
      while (i < lines.length && !interruptsParagraph(lines[i])) paragraph += '\n' + trimLine(lines[i++]);
      const html = inline(paragraph, href);
      if (firstParagraph) { excerpt = html; firstParagraph = false; }
      content += '<p>' + html + '</p>\n';
    }
  }
  return {content, excerpt, toc};
}

function relativePath(directory, pathname) {
  const parts = directory ? directory.split('/') : [];
  for (const part of pathname.split('/')) {
    if (part === '.' || !part) continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

export function run(input) {
  const {files, templates, site} = input;
  const base = site.base_url.replace(/\/+$/, '');
  const output = Object.create(null), report = [];
  const compiled = new Map();
  for (const name of Object.keys(templates).sort()) {
    try {
      compiled.set(name, parseTemplate(templates[name]));
    } catch (error) {
      report.push('template "' + name + '": ' + error);
    }
  }
  const pages = [], posts = [], statics = [], staticPaths = new Set(), urls = new Map();
  const slugs = new Map([['', new Set(['posts', 'tags', 'page'])]]);
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    const {path, content} = file;
    if (!path.endsWith('.md')) {
      statics.push(file);
      staticPaths.add(path);
      continue;
    }
    const normalized = content.includes('\r') ? content.replace(/\r\n?/g, '\n') : content;
    const lines = normalized.split('\n');
    const {data, end, error} = frontMatter(lines);
    const reserved = path.startsWith('tags/') ? 'tags' : path.startsWith('page/') ? 'page' : '';
    const isPost = path.startsWith('posts/');
    const layout = data?.layout ?? (isPost ? 'post' : 'page');
    const refused = error || (reserved && reserved + "/ is the generator's own") ||
      (isPost && !data.date && 'a post needs a date') ||
      (!compiled.has(layout) && 'layout "' + layout + '" is no template that parses');
    if (refused) { report.push('refused ' + path + ': ' + refused); continue; }
    if (data.draft) { report.push('draft ' + path); continue; }
    const directory = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    const destination = isPost ? 'posts' : directory;
    if (!slugs.has(destination)) slugs.set(destination, new Set());
    const slug = unique(data.slug ?? slugify(data.title), slugs.get(destination));
    const permalink = (destination ? destination + '/' : '') + slug + '/';
    const url = base + '/' + permalink;
    urls.set(path, url);
    const date = data.date ?? '';
    const date_long = date ? +date.slice(8) + ' ' + months[+date.slice(5, 7) - 1] + ' ' + date.slice(0, 4) : '';
    let bodyOffset = 0;
    for (let i = 0; i <= end; i++) bodyOffset += lines[i].length + 1;
    const card = {title: data.title, url, date, date_long, summary: data.summary ?? '', excerpt: '',
      reading_minutes: Math.max(1, Math.ceil((normalized.slice(bodyOffset).match(/\S+/g)?.length ?? 0) / 200)),
      tags: []};
    const entry = {path, lines, start: end + 1, directory, layout, slug, permalink, card, isPost, names: data.tags ?? [],
      older: null, newer: null};
    pages.push(entry);
    if (isPost) posts.push(entry);
  }

  const tagSlugs = new Map();
  function nameSlug(name) {
    if (!tagSlugs.has(name)) tagSlugs.set(name, slugify(name));
    return tagSlugs.get(name);
  }
  const tagsBySlug = new Map();
  posts.sort((a, b) => compare(b.card.date, a.card.date) || compare(a.slug, b.slug));
  const postCards = posts.map(post => post.card);
  const neighbors = postCards.map(({title, url, date, date_long}) => ({title, url, date, date_long}));
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i], seen = new Set();
    post.newer = neighbors[i - 1] ?? null;
    post.older = neighbors[i + 1] ?? null;
    for (const name of post.names) {
      const slug = nameSlug(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = tagsBySlug.get(slug);
      if (!tag) {
        tag = {name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: []};
        tagsBySlug.set(slug, tag);
      }
      tag.count++;
      tag.posts.push(post.card);
    }
  }
  const tags = [...tagsBySlug.values()].sort((a, b) => b.count - a.count || compare(a.slug, b.slug));
  const scope = {
    site: {title: site.title, base_url: base},
    tags: tags.map(({name, slug, url, count}) => ({name, slug, url, count})),
    recent: postCards.slice(0, site.recent)
  };
  const broken = new Set();
  for (const entry of pages) {
    const {card, path, directory} = entry;
    const href = target => {
      if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/#])/.test(target)) return target;
      const hash = target.indexOf('#');
      const file = relativePath(directory, hash < 0 ? target : target.slice(0, hash));
      const url = urls.get(file) ?? (staticPaths.has(file) ? base + '/' + file : undefined);
      if (url !== undefined) return url + (hash < 0 ? '' : target.slice(hash));
      broken.add('broken-link ' + path + ' -> ' + target);
      return target;
    };
    entry.markdown = markdown(entry.lines, entry.start, href);
    card.excerpt = entry.markdown.excerpt;
    const seen = new Set();
    for (const spelling of entry.names) {
      const slug = nameSlug(spelling);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = tagsBySlug.get(slug);
      card.tags.push({name: tag?.name ?? spelling, slug, url: tag?.url ?? ''});
    }
  }
  function write(path, name) {
    const template = compiled.get(name);
    if (template) output[path] = render(template, scope, compiled);
  }
  for (const entry of pages) {
    scope.page = {...entry.card, slug: entry.slug, content: entry.markdown.content, toc: entry.markdown.toc,
      older: entry.older, newer: entry.newer, is_post: entry.isPost};
    write(entry.permalink + 'index.html', entry.layout);
  }
  delete scope.page;
  if (compiled.has('index')) {
    const size = site.per_page;
    const total = Math.max(1, Math.ceil(posts.length / size));
    const indexUrl = number => base + (number === 1 ? '/' : '/page/' + number + '/');
    for (let number = 1; number <= total && Number.isFinite(total); number++) {
      scope.posts = postCards.slice((number - 1) * size, number * size);
      scope.pager = {number, total, url: indexUrl(number), newer_url: number > 1 ? indexUrl(number - 1) : '',
        older_url: number < total ? indexUrl(number + 1) : ''};
      write(number === 1 ? 'index.html' : 'page/' + number + '/index.html', 'index');
    }
    delete scope.posts;
    delete scope.pager;
  }
  for (const tag of tags) {
    scope.tag = tag;
    write('tags/' + tag.slug + '/index.html', 'tag');
  }
  delete scope.tag;
  write('tags/index.html', 'tags');
  for (const {path, content} of statics) {
    if (own(output, path)) report.push('shadowed ' + path + ': a built page has its path');
    else if (path !== '__proto__') output[path] = content;
  }
  report.push(...broken);
  report.sort();
  report.push('built ' + (pages.length - posts.length) + ' pages, ' + posts.length + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = report.join('\n') + '\n';
  return output;
}
