import sanitizeHtml from 'sanitize-html';

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img',
    'figure',
    'figcaption',
    'picture',
    'source',
    'video',
    'iframe',
    'del',
    'ins',
    'sup',
    'sub',
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'lang', 'dir'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading'],
    source: ['src', 'srcset', 'type', 'media', 'sizes'],
    video: [
      'src',
      'poster',
      'controls',
      'muted',
      'loop',
      'playsinline',
      'width',
      'height',
    ],
    iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'loading'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    ol: ['start', 'type', 'reversed'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  // Embeds only from video platforms.
  allowedIframeHostnames: [
    'www.youtube.com',
    'www.youtube-nocookie.com',
    'player.vimeo.com',
  ],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs:
        attribs.target === '_blank'
          ? { ...attribs, rel: 'noopener noreferrer' }
          : attribs,
    }),
  },
};

/**
 * Content HTML is sanitized when saved (scripts, event handlers, `javascript:` URLs and foreign
 * iframes are removed), so storefronts can render it as is. `{{block id="…"}}` tokens are text and
 * survive.
 */
export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
