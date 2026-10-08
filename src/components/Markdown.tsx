import { Marked, type Tokens } from 'marked';

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// Nur diese Linkziele werden zu Links; javascript:, data: usw. bleiben reiner Text.
const SAFE_URL = /^(https?:|mailto:)/i;

// Roh-HTML im Markdown wird als Text angezeigt statt ausgefuehrt: Beschreibungen und
// Kommentare kommen auch von Agenten.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escape(token.text);
    },
    link(token: Tokens.Link) {
      const label = this.parser.parseInline(token.tokens);
      if (!SAFE_URL.test(token.href)) return label;
      const title = token.title ? ` title="${escape(token.title)}"` : '';
      return `<a href="${escape(token.href)}"${title} target="_blank" rel="noreferrer">${label}</a>`;
    },
    image(token: Tokens.Image) {
      return escape(`[Bild: ${token.text || token.href}]`);
    },
  },
});

export default function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = marked.parse(text, { async: false });
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
