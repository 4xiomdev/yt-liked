import type { VideoVizView } from './types.js';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;

const C = {
  title: rgb(235, 226, 201),
  text: rgb(214, 214, 220),
  dim: rgb(118, 118, 132),
  line: rgb(72, 72, 86),
  accent: rgb(116, 180, 178),
  warm: rgb(230, 176, 102),
  green: rgb(137, 208, 142),
  coral: rgb(226, 119, 119),
  blue: rgb(126, 170, 230),
  gold: rgb(223, 197, 111),
};

const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const SPARKS = '▁▂▃▄▅▆▇█';

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function bar(value: number, max: number, width: number, color: string): string {
  const ratio = max > 0 ? value / max : 0;
  const filled = ratio * width;
  const full = Math.floor(filled);
  const partial = Math.round((filled - full) * 8);
  return (
    color +
    '█'.repeat(full) +
    (partial > 0 ? BLOCKS[partial] : '') +
    RESET +
    ' '.repeat(Math.max(0, width - full - (partial > 0 ? 1 : 0)))
  );
}

function sparkline(data: number[], color: string): string {
  const max = Math.max(...data, 1);
  return color + data.map((value) => SPARKS[Math.round((value / max) * 7)] ?? SPARKS[0]).join('') + RESET;
}

function boxTop(width: number): string {
  return C.line + '╭' + '─'.repeat(width - 2) + '╮' + RESET;
}

function boxBottom(width: number): string {
  return C.line + '╰' + '─'.repeat(width - 2) + '╯' + RESET;
}

function boxDivider(width: number): string {
  return C.line + '├' + '─'.repeat(width - 2) + '┤' + RESET;
}

function boxRow(content: string, width: number): string {
  const pad = Math.max(0, width - 4 - stripAnsi(content).length);
  return `${C.line}│ ${RESET}${content}${' '.repeat(pad)}${C.line} │${RESET}`;
}

function pct(part: number, total: number): string {
  if (total <= 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function trimLabel(label: string, width: number): string {
  if (label.length <= width) return label;
  return `${label.slice(0, Math.max(1, width - 1))}…`;
}

function renderRankedRows(
  rows: Array<{ label: string; count: number }>,
  total: number,
  width: number,
  color: string
): string[] {
  if (rows.length === 0) {
    return [boxRow(`${DIM}none yet${RESET}`, width)];
  }

  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  return rows.map((row) => {
    const label = trimLabel(row.label, 14).padEnd(14);
    const count = row.count.toLocaleString().padStart(5);
    const valuePct = pct(row.count, total).padStart(6);
    return boxRow(
      `${C.text}${label}${RESET} ${bar(row.count, maxCount, 14, color)} ${C.text}${count}${RESET} ${DIM}${valuePct}${RESET}`,
      width
    );
  });
}

export function renderVideoViz(view: VideoVizView): string {
  const width = 78;
  const lines: string[] = [];

  const monthCounts = view.monthlyLikes.map((row) => row.count);
  const categoryCoverage = `${view.categorizedCount.toLocaleString()} labeled`;
  const domainCoverage = `${view.domainCount.toLocaleString()} domained`;
  const channelIntegrity = view.channelMetadataLikelyOwnerFallback
    ? `${C.coral}suspect source field${RESET}`
    : `${C.green}${view.distinctChannelTitles.toLocaleString()} channel titles${RESET}`;
  const relabelDominantFallback =
    !view.channelMetadataLikelyOwnerFallback
    && Boolean(view.dominantFallbackChannelTitle)
    && view.dominantFallbackChannelCount >= 25
    && (view.dominantFallbackChannelTitle === 'J' || view.dominantFallbackChannelTitle!.length <= 2);

  lines.push(boxTop(width));
  lines.push(boxRow(`${BOLD}${C.title}YTL Archive Atlas${RESET}  ${DIM}local likes snapshot${RESET}`, width));
  lines.push(boxRow(`${C.text}${view.importedCount.toLocaleString()} videos${RESET}  ${DIM}•${RESET}  ${C.accent}${categoryCoverage}${RESET}  ${DIM}•${RESET}  ${C.blue}${domainCoverage}${RESET}`, width));
  if (monthCounts.length > 0) {
    const left = view.monthlyLikes[0]?.label ?? '';
    const right = view.monthlyLikes.at(-1)?.label ?? '';
    lines.push(boxRow(`${C.warm}${sparkline(monthCounts, C.warm)}${RESET}  ${DIM}${left} → ${right}${RESET}`, width));
  }
  lines.push(boxDivider(width));

  const coverageBarWidth = 40;
  const catDone = Math.round((view.categorizedCount / Math.max(1, view.importedCount)) * coverageBarWidth);
  const domDone = Math.round((view.domainCount / Math.max(1, view.importedCount)) * coverageBarWidth);
  lines.push(boxRow(`${C.text}Category coverage${RESET} ${C.green}${'█'.repeat(catDone)}${DIM}${'·'.repeat(Math.max(0, coverageBarWidth - catDone))}${RESET} ${C.text}${pct(view.categorizedCount, view.importedCount)}${RESET}`, width));
  lines.push(boxRow(`${C.text}Domain coverage  ${RESET} ${C.blue}${'█'.repeat(domDone)}${DIM}${'·'.repeat(Math.max(0, coverageBarWidth - domDone))}${RESET} ${C.text}${pct(view.domainCount, view.importedCount)}${RESET}`, width));

  const privacy = view.privacyBreakdown
    .slice(0, 3)
    .map((row) => `${row.label} ${row.count.toLocaleString()}`)
    .join(` ${DIM}•${RESET} `);
  lines.push(boxRow(`${C.text}Privacy${RESET} ${DIM}${privacy || 'no privacy data'}${RESET}`, width));
  lines.push(boxBottom(width));

  lines.push('');
  lines.push(boxTop(width));
  lines.push(boxRow(`${BOLD}${C.gold}Top categories${RESET}`, width));
  lines.push(...renderRankedRows(view.topCategories.slice(0, 10), view.importedCount, width, C.gold));
  lines.push(boxBottom(width));

  lines.push('');
  lines.push(boxTop(width));
  lines.push(boxRow(`${BOLD}${C.accent}Top domains${RESET}`, width));
  lines.push(...renderRankedRows(view.topDomains.slice(0, 10), view.importedCount, width, C.accent));
  lines.push(boxBottom(width));

  lines.push('');
  lines.push(boxTop(width));
  lines.push(boxRow(`${BOLD}${C.blue}Uploader signal${RESET}`, width));
  lines.push(boxRow(`${C.text}Distinct channel titles:${RESET} ${view.distinctChannelTitles.toLocaleString()}  ${DIM}•${RESET}  ${C.text}Distinct channel ids:${RESET} ${view.distinctChannelIds.toLocaleString()}`, width));
  lines.push(boxRow(`${C.text}Importer integrity:${RESET} ${channelIntegrity}`, width));
  if (view.channelMetadataLikelyOwnerFallback) {
    lines.push(boxRow(`${C.coral}Warning:${RESET} imported channel_title/channel_id appear to reflect the likes playlist owner, not each video's uploader.`, width));
    lines.push(boxRow(`${DIM}That is why the current Top channels view collapses to "J". Run ytl enrich-channels to repair it.${RESET}`, width));
  } else {
    if (relabelDominantFallback) {
      lines.push(boxRow(`${DIM}Residual fallback rows are grouped below as unresolved uploader metadata rather than attributed to your profile.${RESET}`, width));
    }
    lines.push(...renderRankedRows(
      view.topChannels.slice(0, 8).map((row) => ({
        label: relabelDominantFallback && row.channelTitle === view.dominantFallbackChannelTitle
          ? 'Unresolved upldr'
          : row.channelTitle,
        count: row.count,
      })),
      view.importedCount,
      width,
      C.blue
    ));
  }
  lines.push(boxBottom(width));

  lines.push('');
  lines.push(`${DIM}Next:${RESET} ytl enrich-channels   ${DIM}•${RESET} ytl classify-domains   ${DIM}•${RESET} ytl status`);

  return lines.join('\n');
}
