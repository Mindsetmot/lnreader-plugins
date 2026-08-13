import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

const CATEGORY_PATHS: Record<string, string> = {
  ongoing: '/p/on-going.html',
  tamat: '/p/novel-tamat.html',
  oneshot: '/p/oneshot.html',
  drop: '/p/dropaxed.html',
};

class KaitoNovelPlugin implements Plugin.PluginBase {
  id = 'kaitonovel';
  name = 'Kaito Novel';
  icon = 'src/id/kaitonovel/icon.png';
  site = 'https://zerokaito.blogspot.com';
  version = '1.1.0';

  filters = {
    category: {
      type: FilterTypes.Picker,
      label: 'Kategori',
      value: 'ongoing',
      options: [
        { label: 'On-Going', value: 'ongoing' },
        { label: 'Tamat', value: 'tamat' },
        { label: 'Oneshot', value: 'oneshot' },
        { label: 'Drop/Axed', value: 'drop' },
      ],
    },
  } satisfies Filters;

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const category = filters?.category?.value || 'ongoing';
    const path = CATEGORY_PATHS[category] || CATEGORY_PATHS.ongoing;

    const res = await fetchApi(this.site + path);
    const $ = loadCheerio(await res.text());

    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('#post-body a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (
        href &&
        href.includes('zerokaito.blogspot.com') &&
        text.length > 3 &&
        !seen.has(href)
      ) {
        seen.add(href);
        novels.push({
          name: text.replace(/^=>>\s*/, ''),
          path: href.replace(this.site, ''),
          cover:
            $(el).closest('p').prevAll('p').find('img').first().attr('src') ||
            defaultCover,
        });
      }
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const res = await fetchApi(this.site + novelPath);
    const $ = loadCheerio(await res.text());

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1.entry-title').first().text().trim() || 'Untitled',
    };

    novel.cover = $('#post-body img').first().attr('src') || defaultCover;
    novel.status = NovelStatus.Unknown;

    const paragraphs = $('#post-body p').toArray();

    // Genre: paragraf tepat sebelum paragraf "Author(s):"/"Author:"
    const authorIdx = paragraphs.findIndex(p =>
      /Author\(s\):|Author:/.test($(p).text()),
    );
    if (authorIdx > 0) {
      novel.genres = $(paragraphs[authorIdx - 1]).text().trim();
    }

    // Sinopsis: paragraf setelah kata "sinopsis", berhenti di paragraf kosong/gambar
    const sinopsisIdx = paragraphs.findIndex(p =>
      $(p).text().toLowerCase().includes('sinopsis'),
    );
    if (sinopsisIdx >= 0) {
      let summary = '';
      for (let i = sinopsisIdx + 1; i < paragraphs.length; i++) {
        const p = $(paragraphs[i]);
        const text = p.text().trim();
        if (!text || p.find('img').length) break;
        summary += text + '\n\n';
      }
      novel.summary = summary.trim();
    }

    // Daftar chapter: susuri #post-body berurutan, track "Volume N" sebagai prefix
    // buat tiap link chapter yang muncul setelahnya, sampai ganti volume berikutnya
    const chapters: Plugin.ChapterItem[] = [];
    let currentVolume = '';

    $('#post-body')
      .find('p, div, a')
      .each((i, el) => {
        const tag = el.tagName?.toLowerCase();

        if (tag === 'a') {
          const $el = $(el);
          const href = $el.attr('href');
          const text = $el.text().trim();
          const isNav = /Sebelumnya|Selanjutnya|Daftar [Ii]si/.test(text);
          if (
            href &&
            href.includes('zerokaito.blogspot.com') &&
            text &&
            !isNav
          ) {
            chapters.push({
              name: currentVolume ? `${currentVolume} - ${text}` : text,
              path: href.replace(this.site, ''),
              releaseTime: '',
              chapterNumber: chapters.length + 1,
            });
          }
        } else {
          const text = $(el).text().trim();
          const match = text.match(/^Volume\s*(\d+)/i);
          if (match) currentVolume = `Volume ${match[1]}`;
        }
      });

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const res = await fetchApi(this.site + chapterPath);
    const $ = loadCheerio(await res.text());
    const body = $('#post-body').clone();

    body.find('script, style, iframe').remove();
    body.find('a').each((i, el) => {
      const text = $(el).text();
      if (/Sebelumnya|Selanjutnya|Daftar [Ii]si/.test(text)) $(el).remove();
    });

    body.find('img').each((i, img) => {
      const $img = $(img);
      const parentA = $img.closest('a');
      let src = $img.attr('src') || '';
      if (
        parentA.length &&
        /blogger|bp\.blogspot|\.(jpg|jpeg|png|webp)/i.test(
          parentA.attr('href') || '',
        )
      ) {
        src = parentA.attr('href') || src;
      }
      $img.attr('src', src);
    });

    return body.html() || '';
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    // Pakai Blogger JSON Feed API langsung, bukan scrape HTML —
    // lebih stabil karena gak bergantung sama class/tag tema yang bisa ganti-ganti
    const res = await fetchApi(
      `${this.site}/feeds/posts/default?alt=json&max-results=20&q=${encodeURIComponent(
        searchTerm,
      )}`,
    );
    const data = await res.json();
    const entries: any[] = data?.feed?.entry || [];

    const results: Plugin.NovelItem[] = [];
    for (const entry of entries) {
      const title: string = entry?.title?.$t || '';
      const links: any[] = entry?.link || [];
      const altLink = links.find(l => l.rel === 'alternate');
      const href: string | undefined = altLink?.href;
      if (!href || !title) continue;

      const thumb: string | undefined = entry?.media$thumbnail?.url;
      const cover = thumb
        ? thumb.replace(/\/s72-c\//, '/s400/').replace(/\/w72-h72[^/]*\//, '/s400/')
        : defaultCover;

      results.push({
        name: title,
        path: href.replace(this.site, ''),
        cover,
      });
    }
    return results;
  }

  resolveUrl = (path: string) => this.site + path;
}

export default new KaitoNovelPlugin();
