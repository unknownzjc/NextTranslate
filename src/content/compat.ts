import { getMainDomain } from '@shared/site';

export { getMainDomain };

// --- Site Compatibility Layer ---
// Provides site-specific overrides for content extraction on major websites.
// Modeled after FluentRead's compat.ts, adapted for NextTranslate's architecture.

export interface SiteCompat {
  /** CSS selector for the main content container. Tried before defuddle. */
  containerSelector?: string;
  /** Extra element skip checks beyond the generic shouldSkipElement logic. */
  shouldSkip?: (el: Element) => boolean;
  /** Additional tag names to treat as translatable paragraphs. */
  extraParagraphTags?: Set<string>;
  /**
   * CSS selector to directly find translatable paragraph elements.
   * Used for sites where content lives in non-standard tags (e.g. DIV on Twitter).
   * Matched elements are collected in addition to the tag-based walk.
   */
  paragraphSelector?: string;
  /**
   * When true for the current page, only paragraphSelector matches are collected.
   * If the selector yields no matches, extraction falls back to the generic tag walk.
   */
  paragraphSelectorOnly?: boolean | ((pathname: string) => boolean);
}

const EMPTY_COMPAT: SiteCompat = {};

// --- Special content detection ---

function isSpecialContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // URLs
  if (/^https?:\/\//.test(trimmed)) return true;
  // Email
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(trimmed)) return true;
  // @username or u/username
  if (/^[@u\/][\w.-]+$/.test(trimmed)) return true;
  // Commit hashes (7+ hex chars only)
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return true;
  // File paths with extensions
  if (/^[\w./-]+\.\w{1,5}$/.test(trimmed) && trimmed.includes('/')) return true;
  return false;
}

// --- YouTube ---

const youtubeCompat: SiteCompat = {
  containerSelector: 'ytd-app',
  extraParagraphTags: new Set(['YT-FORMATTED-STRING']),
  paragraphSelector: [
    'h1.title yt-formatted-string',
    'div#description-inline-expander yt-formatted-string',
    'yt-formatted-string#content-text',
    'span.captions-text',
  ].join(', '),
  shouldSkip(el: Element): boolean {
    const tag = el.tagName;
    // Skip SVG/IMG
    if (tag === 'svg' || tag === 'IMG') return true;
    // Skip player controls
    if (el.closest('[class*="ytp-"]')) return true;
    // Skip buttons, subscribe, like
    if (el.closest('#subscribe-button, #top-level-buttons-computed, .ytd-menu-renderer')) return true;
    if (el.closest('ytd-button-renderer, tp-yt-paper-button, yt-icon')) return true;
    // Skip thumbnails, avatar, badges
    if (el.closest('ytd-thumbnail, #avatar, .badge-style-type-simple')) return true;
    // Skip sidebar and navigation
    if (el.closest('ytd-mini-guide-renderer, ytd-guide-renderer, #guide')) return true;
    // Skip chips/filters
    if (el.closest('yt-chip-cloud-renderer, ytd-feed-filter-chip-bar-renderer')) return true;
    // Skip metadata numbers (views, dates, sub counts)
    const text = (el.textContent ?? '').trim();
    if (/^\d+(\.\d+)?[KMB]?\s*(views?|subscribers?|likes?|dislikes?)?$/i.test(text)) return true;
    if (/^\d+:\d{2}(:\d{2})?$/.test(text)) return true;
    if (/^\d+\s*(years?|months?|weeks?|days?|hours?|minutes?|seconds?)\s*ago$/i.test(text)) return true;
    // Short UI labels
    if (['Subscribe', 'Share', 'Like', 'Dislike', 'Save', 'Clip', 'Download', 'Thanks'].includes(text)) return true;
    return false;
  },
};

// --- Twitter / X ---

const twitterCompat: SiteCompat = {
  containerSelector: '[data-testid="primaryColumn"]',
  paragraphSelector: [
    'div[data-testid="tweetText"]',
    'div[data-testid="UserDescription"]',
    'div[data-testid="birdwatch-pivot"] span',
    'article div[lang]',
  ].join(', '),
  shouldSkip(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'svg' || tag === 'path' || tag === 'g') return true;
    // Skip sidebar
    if (el.closest('[data-testid="sidebarColumn"]')) return true;
    // Skip trending pane
    if (el.closest('[data-testid="trend"]')) return true;
    // Skip buttons and actions
    if (el.closest('[role="button"], [data-testid="like"], [data-testid="retweet"], [data-testid="reply"]')) return true;
    // Skip bottom bar / nav
    if (el.closest('nav[role="navigation"]')) return true;
    // Skip user handles and short UI text
    const text = (el.textContent ?? '').trim();
    if (text.startsWith('@')) return true;
    if (/^(\d+|Like|Reply|Retweet|Share|Follow)$/i.test(text)) return true;
    // Skip username-only cells (short text with all r-/css- classes)
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(' ');
      if (classes.every(c => c.startsWith('r-') || c.startsWith('css-')) && text.length < 10) return true;
    }
    if (isSpecialContent(text)) return true;
    return false;
  },
};

// --- GitHub ---

function isGitHubIssueListPage(pathname: string): boolean {
  return /^\/[^/]+\/[^/]+\/issues\/?$/.test(pathname);
}

function isGitHubPullListPage(pathname: string): boolean {
  return /^\/[^/]+\/[^/]+\/pulls\/?$/.test(pathname);
}

function isGitHubListPage(pathname: string): boolean {
  return isGitHubIssueListPage(pathname) || isGitHubPullListPage(pathname);
}

function isGitHubAttachmentText(text: string): boolean {
  return /^[\w .()/-]+\.(?:json|txt|log|png|jpe?g|gif|webp|svg|pdf|zip|tar|gz|tgz|bz2|7z|csv)$/i.test(text);
}

function isGitHubMetadataLine(text: string): boolean {
  return /^(?:CLI Version|Git Commit|Session ID|Operating System|Sandbox Environment|Model Version|Auth Type|Memory Usage|Terminal Name|Terminal Background|Kitty Keyboard Protocol|Node(?:\.js)? Version|npm Version|pnpm Version|Yarn Version|Browser Version|Extension Version|Platform|Runtime|Environment):\s+/i.test(text);
}

function isGitHubReactionNotice(text: string): boolean {
  return /\breacted via\b/i.test(text) || /^\p{Emoji_Presentation}?\s*.+\s+reacted via\s+\w+/iu.test(text);
}

function isGitHubLeafLike(el: Element): boolean {
  return el.children.length === 0 || el.matches([
    'p',
    'li',
    'td',
    'th',
    '.email-fragment',
    '[data-listview-item-title-container] > h3',
    'bdi[data-testid="issue-title"]',
    'a.markdown-title[href*="/pull/"]',
    'h1[data-component="PH_Title"] > span.markdown-title',
  ].join(', '));
}

function getGitHubRepoSidebarRow(el: Element): Element | null {
  const row = el.closest('.BorderGrid-row');
  if (!row) return null;
  if (!row.closest('[data-partial-name="codeViewRepoRoute.Sidebar"], .prc-PageLayout-PaneWrapper-pHPop[data-position="end"]')) {
    return null;
  }
  return row;
}

function getGitHubRepoSidebarSectionName(el: Element): string | null {
  const row = getGitHubRepoSidebarRow(el);
  if (!row) return null;

  const heading = row.querySelector('h2');
  if (!heading) return null;

  return (heading.textContent ?? '')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isGitHubRepoAboutText(el: Element): boolean {
  const row = getGitHubRepoSidebarRow(el);
  if (!row) return false;
  if (getGitHubRepoSidebarSectionName(el) !== 'about') return false;

  const description = row.querySelector('p.f4, p');
  return el.matches('h2') || description === el;
}

const githubCompat: SiteCompat = {
  containerSelector: '#repo-content-turbo-frame, .repository-content, .js-issue-title + *, [data-target="readme-toc.content"], .comment-body, #diff-comparison-viewer-container',
  paragraphSelector: [
    '[data-listview-item-title-container] > h3',
    'bdi[data-testid="issue-title"]',
    'h1[data-component="PH_Title"] > span.markdown-title',
    'a.markdown-title[href*="/pull/"]',
    '.email-fragment',
  ].join(', '),
  paragraphSelectorOnly: (pathname: string) => isGitHubListPage(pathname),
  shouldSkip(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'svg' || tag === 'PRE' || tag === 'CODE') return true;
    if (el.matches('h1[data-component="PH_Title"]')) return true;

    // Skip GitHub chrome, sidebars, tabs, and header metadata.
    if (el.closest('.AppHeader, .pagehead, .UnderlineNav, .subnav, .tabnav, .reponav, .pagehead-actions, #repository-details-container')) return true;
    if (el.closest('.BorderGrid--spacious .BorderGrid-cell:last-child')) return true;
    if (el.closest('.prc-PageLayout-SidebarWrapper-kLG4B, .prc-PageLayout-Sidebar-iciWg, .discussion-sidebar, .discussion-sidebar-item, .js-discussion-sidebar-item, .pull-discussion-sidebar, .sidebar-assignee, .sidebar-reviewers, .js-issue-sidebar-form')) return true;
    if (getGitHubRepoSidebarSectionName(el) && !isGitHubRepoAboutText(el) && isGitHubLeafLike(el)) return true;
    if (el.closest('[aria-label="Pull request navigation tabs"], [role="tablist"]')) return true;
    if (el.closest('.prc-PageHeader-Description-w-ejP')) return true;

    // Skip repo file lists / trees, code blocks, breadcrumbs.
    if (el.closest('[aria-labelledby="folders-and-files"], .react-directory-filename-column, .file-navigation, nav[aria-label="Breadcrumb"]')) return true;
    if (el.closest('.js-file-line, .blob-code, .highlight')) return true;
    if (el.closest('.email-hidden-reply, .email-hidden-toggle, .email-quoted-reply')) return true;

    // Skip commit info, counters, labels, actions.
    if (el.closest('.commit-tease, .Counter, .IssueLabel, .label-link, .topic-tag')) return true;
    if (el.closest('.btn, .BtnGroup, .social-count, .starring-container')) return true;

    // Skip UI headings outside markdown content; title is handled by paragraphSelector.
    if (/^H[1-6]$/.test(tag) && !el.closest('.markdown-body, .comment-body, .email-fragment, [data-listview-item-title-container], h1[data-component="PH_Title"]') && !isGitHubRepoAboutText(el)) {
      return true;
    }

    const text = (el.textContent ?? '').trim();
    if (isGitHubLeafLike(el)) {
      if (/^[a-f0-9]{7,40}$/.test(text)) return true; // commit hash
      if (/^#\d+$/.test(text)) return true; // issue / PR number
      if (/^[\w./-]+\.(js|ts|tsx|jsx|py|go|rs|rb|java|c|cpp|h|css|html|md|json|yml|yaml|toml|lock|sh|sql)$/i.test(text)) return true;
      if (isGitHubAttachmentText(text)) return true;
      if (isGitHubMetadataLine(text)) return true;
      if (isGitHubReactionNotice(text)) return true;

      const links = el.querySelectorAll('a');
      if (links.length === 1) {
        const onlyLink = links[0];
        const linkText = (onlyLink.textContent ?? '').trim();
        const href = onlyLink.getAttribute('href') ?? '';
        if (linkText === text && (href.includes('/user-attachments/') || isGitHubAttachmentText(linkText))) {
          return true;
        }
      }
    }

    if (isSpecialContent(text)) return true;
    return false;
  },
};

// --- StackOverflow ---

const stackoverflowCompat: SiteCompat = {
  containerSelector: '#mainbar, #content',
  shouldSkip(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'svg' || tag === 'PRE' || tag === 'CODE') return true;
    // Skip sidebar, topbar, navigation
    if (el.closest('#sidebar, .top-bar, .s-topbar, .js-filter-btn')) return true;
    // Skip vote controls, tags, user cards
    if (el.closest('.js-vote-count, .vote-count-post, .post-tag, .user-card, .user-info')) return true;
    // Skip code blocks
    if (el.closest('.s-code-block, .snippet-code')) return true;
    // Skip badges and buttons
    if (el.closest('.s-badge, .s-btn, .js-post-menu')) return true;
    if (isSpecialContent((el.textContent ?? '').trim())) return true;
    return false;
  },
};

// --- Medium ---

const mediumCompat: SiteCompat = {
  containerSelector: 'article',
  shouldSkip(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'svg' || tag === 'IMG' || tag === 'PRE' || tag === 'CODE') return true;
    // Skip nav, metabar, sidebar, overlays
    if (el.closest('nav, [class*="metabar"], [class*="overlay"], [class*="postActionsBar"]')) return true;
    // Skip author card and paywall elements
    if (el.closest('[class*="u-paddingTop"], [class*="js-stickyFooter"]')) return true;
    if (isSpecialContent((el.textContent ?? '').trim())) return true;
    return false;
  },
};

// --- Reddit ---

const redditCompat: SiteCompat = {
  containerSelector: '[data-testid="post-container"], .Post, #AppRouter-main-content, shreddit-app',
  shouldSkip(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'img' || tag === 'faceplate-screen-reader-content' || tag === 'time') return true;
    if (tag === 'faceplate-timeago' || tag === 'shreddit-post-flair') return true;
    // Skip vote buttons, award badges
    if (el.closest('[data-click-id="upvote"], [data-click-id="downvote"], .voteButton')) return true;
    if (el.closest('[class*="award"], [class*="icon"], [class*="vote"]')) return true;
    // Skip author, sidebar
    if (el.closest('[data-testid="subreddit-sidebar"], [class*="sidebar"]')) return true;
    // Username and community patterns
    const text = (el.textContent ?? '').trim();
    if (/^[ur]\/\w+$/.test(text)) return true;
    if (/^\d+(\.\d+)?[kKmM]?\s*(comments?|points?|upvotes?)?$/.test(text)) return true;
    if (/^\d+\s*(minutes?|hours?|days?|weeks?|months?|years?)\s*ago$/i.test(text)) return true;
    if (isSpecialContent(text)) return true;
    return false;
  },
};

// --- Hacker News ---

const hackerNewsCompat: SiteCompat = {
  containerSelector: '#hnmain',
  paragraphSelector: [
    'td.title a.titlelink',
    'div.comment span.commtext',
    'div.toptext',
  ].join(', '),
  shouldSkip(el: Element): boolean {
    // Skip navigation
    if (el.closest('td.hnnavbar, .pagetop')) return true;
    // Skip subtext (points, author, time, comments link)
    if (el.closest('td.subtext, span.subline')) return true;
    // Skip user links in comments
    if (el.closest('span.hnuser, span.age')) return true;
    // Skip forms
    if (el.closest('form')) return true;
    // Skip short UI text
    const text = (el.textContent ?? '').trim().toLowerCase();
    if (['reply', 'flag', 'favorite', 'hide', 'past', 'web', 'comments', 'ask', 'show', 'jobs', 'submit', 'login'].includes(text)) return true;
    if (isSpecialContent(text)) return true;
    return false;
  },
};

// --- Site registry ---

const siteRegistry: Record<string, SiteCompat> = {
  'youtube.com': youtubeCompat,
  'x.com': twitterCompat,
  'github.com': githubCompat,
  'stackoverflow.com': stackoverflowCompat,
  'medium.com': mediumCompat,
  'reddit.com': redditCompat,
  'news.ycombinator.com': hackerNewsCompat,
  'ycombinator.com': hackerNewsCompat,
};

export function getSiteCompat(hostname: string): SiteCompat {
  const host = hostname.replace(/^www\./, '');
  // Try exact hostname first (e.g. news.ycombinator.com)
  if (siteRegistry[host]) return siteRegistry[host];
  // Then try main domain (e.g. ycombinator.com)
  const domain = getMainDomain(hostname);
  return siteRegistry[domain] ?? EMPTY_COMPAT;
}
