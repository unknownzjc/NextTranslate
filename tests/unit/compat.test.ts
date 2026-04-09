import { describe, it, expect } from 'vitest';
import { getMainDomain, getSiteCompat } from '../../src/content/compat';

describe('getMainDomain', () => {
  it('strips www prefix', () => {
    expect(getMainDomain('www.github.com')).toBe('github.com');
  });

  it('normalizes twitter.com to x.com', () => {
    expect(getMainDomain('twitter.com')).toBe('x.com');
    expect(getMainDomain('www.twitter.com')).toBe('x.com');
  });

  it('normalizes x.com', () => {
    expect(getMainDomain('x.com')).toBe('x.com');
  });

  it('handles two-part TLDs', () => {
    expect(getMainDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('returns main domain for standard hostnames', () => {
    expect(getMainDomain('www.youtube.com')).toBe('youtube.com');
    expect(getMainDomain('stackoverflow.com')).toBe('stackoverflow.com');
    expect(getMainDomain('news.ycombinator.com')).toBe('ycombinator.com');
  });

  it('handles subdomain-rich hostnames', () => {
    expect(getMainDomain('gist.github.com')).toBe('github.com');
  });
});

describe('getSiteCompat', () => {
  it('returns YouTube compat for youtube.com', () => {
    const compat = getSiteCompat('www.youtube.com');
    expect(compat.containerSelector).toBe('ytd-app');
    expect(compat.shouldSkip).toBeDefined();
    expect(compat.extraParagraphTags).toBeDefined();
    expect(compat.extraParagraphTags!.has('YT-FORMATTED-STRING')).toBe(true);
  });

  it('returns Twitter compat for x.com and twitter.com', () => {
    const compat1 = getSiteCompat('x.com');
    const compat2 = getSiteCompat('twitter.com');
    expect(compat1.containerSelector).toBe('[data-testid="primaryColumn"]');
    expect(compat2.containerSelector).toBe('[data-testid="primaryColumn"]');
    expect(compat1.paragraphSelector).toContain('tweetText');
    expect(compat1.paragraphSelector).toContain('UserDescription');
    expect(compat1.shouldSkipText).toBeDefined();
  });

  it('returns GitHub compat', () => {
    const compat = getSiteCompat('github.com');
    expect(compat.containerSelector).toContain('#diff-comparison-viewer-container');
    expect(compat.containerSelector).toContain('.repository-content');
    expect(compat.shouldSkip).toBeDefined();
    expect(compat.paragraphSelector).toContain('[data-listview-item-title-container] > h3');
    expect(compat.paragraphSelector).toContain('bdi[data-testid="issue-title"]');
    expect(compat.paragraphSelector).toContain('h1[data-component="PH_Title"] > span.markdown-title');
    expect(compat.paragraphSelector).toContain('a.markdown-title[href*="/pull/"]');
    expect(compat.paragraphSelector).toContain('.email-fragment');
    expect(typeof compat.paragraphSelectorOnly).toBe('function');
    expect((compat.paragraphSelectorOnly as (pathname: string) => boolean)('/foo/bar/issues')).toBe(true);
    expect((compat.paragraphSelectorOnly as (pathname: string) => boolean)('/foo/bar/pulls')).toBe(true);
    expect((compat.paragraphSelectorOnly as (pathname: string) => boolean)('/foo/bar/issues/123')).toBe(false);
    expect((compat.paragraphSelectorOnly as (pathname: string) => boolean)('/foo/bar/pull/123')).toBe(false);
    expect((compat.paragraphSelectorOnly as (pathname: string) => boolean)('/foo/bar')).toBe(false);
  });

  it('returns StackOverflow compat', () => {
    const compat = getSiteCompat('stackoverflow.com');
    expect(compat.containerSelector).toContain('#mainbar');
  });

  it('returns Medium compat', () => {
    const compat = getSiteCompat('medium.com');
    expect(compat.containerSelector).toBe('article');
  });

  it('returns Reddit compat', () => {
    const compat = getSiteCompat('reddit.com');
    expect(compat.containerSelector).toContain('post-container');
  });

  it('returns HN compat', () => {
    const compat = getSiteCompat('news.ycombinator.com');
    expect(compat.containerSelector).toBe('#hnmain');
    expect(compat.paragraphSelector).toContain('span.titleline > a');
    expect(compat.paragraphSelector).toContain('div.comment .commtext');
    expect(compat.paragraphSelectorOnly).toBe(true);
  });

  it('returns empty compat for unknown sites', () => {
    const compat = getSiteCompat('example.com');
    expect(compat.containerSelector).toBeUndefined();
    expect(compat.shouldSkip).toBeUndefined();
    expect(compat.extraParagraphTags).toBeUndefined();
  });
});

describe('YouTube shouldSkip', () => {
  const compat = getSiteCompat('youtube.com');

  it('skips SVG elements', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    expect(compat.shouldSkip!(svg)).toBe(true);
    svg.remove();
  });

  it('skips timestamp text', () => {
    const el = document.createElement('span');
    el.textContent = '12:34';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips view count text', () => {
    const el = document.createElement('span');
    el.textContent = '1.2M views';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips UI labels like Subscribe', () => {
    const el = document.createElement('span');
    el.textContent = 'Subscribe';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('does not skip normal text', () => {
    const el = document.createElement('p');
    el.textContent = 'This is a video description about programming tutorials';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(false);
    el.remove();
  });
});

describe('Twitter shouldSkip', () => {
  const compat = getSiteCompat('x.com');

  it('skips @username text', () => {
    const el = document.createElement('span');
    el.textContent = '@elonmusk';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips UI text like Like/Reply', () => {
    const el = document.createElement('span');
    el.textContent = 'Like';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('does not skip tweet text', () => {
    const el = document.createElement('div');
    el.textContent = 'Just shipped a new feature for our translation extension!';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(false);
    el.remove();
  });

  it('通过 shouldSkipText 跳过中文主导且只有少量英文术语的 tweet', () => {
    expect(compat.shouldSkipText?.('今天修复了 login bug，终于稳定了')).toBe(true);
  });

  it('通过 shouldSkipText 对低置信度中英混合文本保持保守', () => {
    expect(compat.shouldSkipText?.('中文说明 English context mixed together')).toBe(false);
  });
});


describe('GitHub shouldSkip', () => {
  const compat = getSiteCompat('github.com');

  it('skips commit hashes', () => {
    const el = document.createElement('span');
    el.textContent = 'abc1234';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips issue numbers', () => {
    const el = document.createElement('span');
    el.textContent = '#123';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips file names with extensions', () => {
    const el = document.createElement('span');
    el.textContent = 'index.ts';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('does not skip comment body text', () => {
    const el = document.createElement('p');
    el.textContent = 'This bug occurs when the user clicks the submit button twice';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(false);
    el.remove();
  });

  it('skips quoted email reply content', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'email-hidden-reply';
    const el = document.createElement('div');
    el.className = 'email-fragment';
    el.textContent = 'Quoted email reply that should not be translated again';
    wrapper.appendChild(el);
    document.body.appendChild(wrapper);
    expect(compat.shouldSkip!(el)).toBe(true);
    wrapper.remove();
  });

  it('skips attachments', () => {
    const el = document.createElement('p');
    el.textContent = 'bug-report-history-1775328468610.json';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips version and environment metadata lines', () => {
    const el = document.createElement('li');
    el.textContent = 'CLI Version: 0.36.0';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips reaction notices', () => {
    const el = document.createElement('div');
    el.className = 'email-fragment';
    el.textContent = '🧞 Richard reacted via Gmail';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips PR page header metadata text', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'prc-PageHeader-Description-w-ejP';
    const el = document.createElement('span');
    el.textContent = 'student wants to merge 2 commits into main from feature-branch';
    wrapper.appendChild(el);
    document.body.appendChild(wrapper);
    expect(compat.shouldSkip!(el)).toBe(true);
    wrapper.remove();
  });

  it('skips sidebar headings outside markdown content', () => {
    const sidebar = document.createElement('aside');
    sidebar.className = 'prc-PageLayout-SidebarWrapper-kLG4B';
    const el = document.createElement('h3');
    el.textContent = 'Reviewers';
    sidebar.appendChild(el);
    document.body.appendChild(sidebar);
    expect(compat.shouldSkip!(el)).toBe(true);
    sidebar.remove();
  });

  it('skips legacy GitHub discussion sidebar items like Reviewers', () => {
    const sidebarItem = document.createElement('div');
    sidebarItem.className = 'discussion-sidebar-item js-discussion-sidebar-item sidebar-assignee';
    const el = document.createElement('p');
    el.textContent = 'gemini-code-assist[bot] left review comments';
    sidebarItem.appendChild(el);
    document.body.appendChild(sidebarItem);
    expect(compat.shouldSkip!(el)).toBe(true);
    sidebarItem.remove();
  });

  it('skips all content inside js-issue-sidebar-form', () => {
    const form = document.createElement('form');
    form.className = 'js-issue-sidebar-form';
    const el = document.createElement('p');
    el.textContent = 'Reviewers and other sidebar content should not be translated';
    form.appendChild(el);
    document.body.appendChild(form);
    expect(compat.shouldSkip!(el)).toBe(true);
    form.remove();
  });

  it('skips GitHub repository file tables labelled folders-and-files', () => {
    const table = document.createElement('table');
    table.setAttribute('aria-labelledby', 'folders-and-files');
    const cell = document.createElement('th');
    cell.textContent = 'Last commit message';
    table.appendChild(cell);
    document.body.appendChild(table);
    expect(compat.shouldSkip!(cell)).toBe(true);
    table.remove();
  });

  it('skips GitHub repository header actions like Watch / Fork / Star', () => {
    const actions = document.createElement('ul');
    actions.className = 'pagehead-actions';
    const item = document.createElement('li');
    item.textContent = 'Watch';
    actions.appendChild(item);
    document.body.appendChild(actions);
    expect(compat.shouldSkip!(item)).toBe(true);
    actions.remove();
  });

  it('does not skip the GitHub repository sidebar About heading and description', () => {
    const partial = document.createElement('rails-partial');
    partial.setAttribute('data-partial-name', 'codeViewRepoRoute.Sidebar');
    partial.innerHTML = `
      <div class="BorderGrid">
        <div class="BorderGrid-row">
          <div class="BorderGrid-cell">
            <h2>About</h2>
            <p class="f4">An open-source AI agent that brings the power of Gemini directly into your terminal.</p>
            <h3>Topics</h3>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(partial);

    const heading = partial.querySelector('h2')!;
    const description = partial.querySelector('p.f4')!;
    const topics = partial.querySelector('h3')!;

    expect(compat.shouldSkip!(heading)).toBe(false);
    expect(compat.shouldSkip!(description)).toBe(false);
    expect(compat.shouldSkip!(topics)).toBe(true);
    partial.remove();
  });

  it('skips non-About sections in the GitHub repository right sidebar', () => {
    const partial = document.createElement('rails-partial');
    partial.setAttribute('data-partial-name', 'codeViewRepoRoute.Sidebar');
    partial.innerHTML = `
      <div class="BorderGrid">
        <div class="BorderGrid-row">
          <div class="BorderGrid-cell">
            <h2>Deployments</h2>
            <p>Production deployment status and environment metadata should not be translated here.</p>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(partial);

    const el = partial.querySelector('p')!;
    expect(compat.shouldSkip!(el)).toBe(true);
    partial.remove();
  });
});

describe('Reddit shouldSkip', () => {
  const compat = getSiteCompat('reddit.com');

  it('skips subreddit names', () => {
    const el = document.createElement('span');
    el.textContent = 'r/programming';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips usernames', () => {
    const el = document.createElement('span');
    el.textContent = 'u/testuser';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips relative timestamps', () => {
    const el = document.createElement('span');
    el.textContent = '3 hours ago';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('does not skip post content', () => {
    const el = document.createElement('p');
    el.textContent = 'I have been working on a new open source translation extension';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(false);
    el.remove();
  });
});

describe('HackerNews shouldSkip', () => {
  const compat = getSiteCompat('news.ycombinator.com');

  it('skips UI text like reply/flag', () => {
    const el = document.createElement('span');
    el.textContent = 'reply';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips comhead metadata', () => {
    const el = document.createElement('span');
    el.className = 'comhead';
    el.textContent = 'gertlabs 9 hours ago | next [–]';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('skips sitebit/comhead source text', () => {
    const el = document.createElement('span');
    el.className = 'sitebit comhead';
    el.textContent = '(z.ai)';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(true);
    el.remove();
  });

  it('does not skip comment text', () => {
    const el = document.createElement('span');
    el.textContent = 'This is a really insightful comment about the article';
    document.body.appendChild(el);
    expect(compat.shouldSkip!(el)).toBe(false);
    el.remove();
  });
});

describe('Twitter paragraphSelector', () => {
  it('matches tweet text divs', () => {
    const compat = getSiteCompat('x.com');
    const container = document.createElement('div');
    const tweet = document.createElement('div');
    tweet.setAttribute('data-testid', 'tweetText');
    tweet.textContent = 'This is a tweet about AI and the future of technology';
    container.appendChild(tweet);
    document.body.appendChild(container);

    const matched = container.querySelectorAll(compat.paragraphSelector!);
    expect(matched.length).toBe(1);
    expect(matched[0]).toBe(tweet);

    container.remove();
  });

  it('matches user description divs', () => {
    const compat = getSiteCompat('x.com');
    const container = document.createElement('div');
    const bio = document.createElement('div');
    bio.setAttribute('data-testid', 'UserDescription');
    bio.textContent = 'AI researcher and engineer working on language models';
    container.appendChild(bio);
    document.body.appendChild(container);

    const matched = container.querySelectorAll(compat.paragraphSelector!);
    expect(matched.length).toBe(1);
    expect(matched[0]).toBe(bio);

    container.remove();
  });

  it('matches multiple tweets in a timeline', () => {
    const compat = getSiteCompat('x.com');
    const container = document.createElement('div');

    for (let i = 0; i < 3; i++) {
      const tweet = document.createElement('div');
      tweet.setAttribute('data-testid', 'tweetText');
      tweet.textContent = `Tweet number ${i} with enough text to translate`;
      container.appendChild(tweet);
    }
    document.body.appendChild(container);

    const matched = container.querySelectorAll(compat.paragraphSelector!);
    expect(matched.length).toBe(3);

    container.remove();
  });
  it('matches X article title and longform body blocks', () => {
    const compat = getSiteCompat('x.com');
    const container = document.createElement('div');
    container.innerHTML = `
      <div data-testid="twitter-article-title">The File System Is the New Database: How I Built a Personal OS for AI Agents</div>
      <div data-testid="twitterArticleRichTextView">
        <div class="longform-unstyled">Every AI conversation starts the same way. You explain who you are and what you're working on.</div>
        <div class="public-DraftStyleDefault-block public-DraftStyleDefault-ltr">Every AI conversation starts the same way. You explain who you are and what you're working on.</div>
      </div>
    `;
    document.body.appendChild(container);

    const matched = Array.from(container.querySelectorAll(compat.paragraphSelector!));
    expect(matched).toHaveLength(2);
    expect(matched[0]?.getAttribute('data-testid')).toBe('twitter-article-title');
    expect(matched[1]?.className).toContain('longform-unstyled');

    container.remove();
  });

});
