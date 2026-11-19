export const ACCENTS = ['#3ddc84', '#4f8cff', '#b06cff', '#ff7a59', '#ffc145', '#ff5fa2', '#2ed3d3']

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export function formatPlaytime(secs: number): string {
  if (secs < 60) return 'ещё не играли'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h === 0) return `${m} мин`
  return `${h} ч ${m} мин`
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'никогда'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return 'только что'
  if (diff < 3600) {
    const m = Math.floor(diff / 60)
    return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`
  }
  const d = Math.floor(diff / 86400)
  if (d === 1) return 'вчера'
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} млн`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} тыс`
  return String(n)
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} МБ`
  return `${Math.max(1, Math.round(bytes / 1e3))} КБ`
}

export function formatMemory(mb: number): string {
  return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} ГБ`
}

/** Примерная Java для подсказки в интерфейсе (точную берёт бэкенд из манифеста) */
export function guessJava(version: string): number | null {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(version)
  if (!m) return null
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor <= 16) return 8
  if (minor < 20 || (minor === 20 && patch < 5)) return 17
  return 21
}

export function loaderName(loader: string | null): string {
  switch (loader) {
    case 'fabric':
      return 'Fabric'
    case 'quilt':
      return 'Quilt'
    case 'forge':
      return 'Forge'
    case 'neoforge':
      return 'NeoForge'
    default:
      return 'Vanilla'
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Доброй ночи'
  if (h < 12) return 'Доброе утро'
  if (h < 18) return 'Добрый день'
  return 'Добрый вечер'
}
