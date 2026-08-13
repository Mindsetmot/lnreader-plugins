import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

const CATEGORY_PATHS: Record<string, string> = {
  ln: '/p/proyek-terjemahan-ln.html',
  wn: '/p/proyek-terjemahan-wn.html',
};

// Label-label info novel di halaman TOC, dipakai buat nentuin batas ekstraksi
// tiap field (Genre, Penulis, Sinopsis, dst) lewat lookahead ke label berikutnya.
const INFO_LABELS = [
  'Judul Asli',
  'Judul Alternatif',
  'Judul Inggris',
  'Judul Indonesia',
  'Jenis/Tipe',
  'Genre',
  'Penulis/Author',
  'Pelukis/Artist',
  'Tahun',
  'Sumber Terjemahan',
  'Penerjemah/Translator',
  'Baca juga',
  'Sinopsis',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function extractField(fullText: string, label: string): string | undefined {
  const terminators = INFO_LABELS.map(l => escapeRegex(l) + '\\s*:').join('|');
  const pattern = new RegExp(
    `${escapeRegex(label)}\\s*:\\s*(.+?)(?=${terminators}|Jilid\\s*\\d|$)`,
    'is',
  );
  const match = fullText.match(pattern);
  return match ? match[1].trim() : undefined;
}

class LintasNinjaPlugin implements Plugin.PluginBase {
  id = 'lintasninja';
  name = 'Lintas Ninja Translation';
  icon = 'src/id/lintasninja/icon.png';
  site = 'https://lintasninjanovel.blogspot.com';
  version = '1.0.0';

  filters = {
    category: {
      type: FilterTypes.Picker,
      label: 'Kategori',
      value: 'ln',
      options: [
        { label: 'Light Novel', value: 'ln' },
        { label: 'Web Novel', value: 'wn' },
      ],
    },
  } satisfies Filters;

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const category = filters?.category?.value || 'ln';
    const path = CATEGORY_PATHS[category] || CATEGORY_PATHS.ln;

    const res = await fetchApi(this.site + path);
    const $ = loadCheerio(await res.text());

    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('#post-body a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (
        href &&
        href.includes('lintasninjanovel.blogspot.com') &&
        text.length > 3 &&
        !seen.has(href)
      ) {
        seen.add(href);
        novels.push({
          name: text,
          path: href.replace(this.site, ''),
          cover: defaultCover,
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
      name: $('#post-body h2').first().text().trim() || 'Untitled',
    };

    novel.cover = $('#post-body img').first().attr('src') || defaultCover;
    novel.status = NovelStatus.Unknown;

    const fullText = $('#post-body').text();
    novel.genres = extractField(fullText, 'Genre');
    novel.author = extractField(fullText, 'Penulis/Author');
    novel.summary = extractField(fullText, 'Sinopsis');

    // Daftar chapter: susuri #post-body berurutan, track "Jilid N" sebagai prefix
    // buat tiap link chapter yang muncul setelahnya
    const chapters: Plugin.ChapterItem[] = [];
    let currentVolume = '';

    $('#post-body')
      .find('div, b, a')
      .each((i, el) => {
        const tag = el.tagName?.toLowerCase();

        if (tag === 'a') {
          const $el = $(el);
          const href = $el.attr('href');
          const text = $el.text().trim();
          if (
            href &&
            href.includes('lintasninjanovel.blogspot.com') &&
            text &&
            !/^(Facebook|Twitter|WhatsApp|Pinterest|Reddit|LinkedIn|Tumblr|Telegram|Email)$/i.test(
              text,
            )
          ) {
            chapters.push({
              name: currentVolume ? `${currentVolume} - ${text}` : text,
              path: href.replace(this.site, ''),
              releaseTime: '',
              chapterNumber: chapters.length + 1,
            });
          }
        } else if (tag === 'b') {
          const text = $(el).text().trim();
          const match = text.match(/^Jilid\s*(\d+)/i);
          if (match) currentVolume = `Jilid ${match[1]}`;
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
    // JSON Feed API Blogger — sama kayak Kaito Novel, gak perlu scrape HTML
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

export default new LintasNinjaPlugin();
