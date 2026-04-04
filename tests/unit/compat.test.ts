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
  });

  it('returns GitHub compat', () => {
    const compat = getSiteCompat('github.com');
    expect(compat.containerSelector).toContain('.repository-content');
    expect(compat.shouldSkip).toBeDefined();
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
});
