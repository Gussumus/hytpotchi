import type { ComponentType } from 'react'
import {
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  CircleUserRound,
  Clock,
  Coffee,
  Compass,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Heart,
  House,
  Images,
  Minus,
  Package,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shirt,
  Crown,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  UserPlus,
  Users,
  Send,
  TriangleAlert,
  Upload,
  X,
  type LucideProps,
} from 'lucide-react'

type P = LucideProps

/** Единый стиль иконок: Lucide, толщина 1.9, по умолчанию 18px */
function icon(C: ComponentType<LucideProps>, filled = false) {
  return function Icon(p: P) {
    return (
      <C
        size={18}
        strokeWidth={1.9}
        absoluteStrokeWidth={false}
        aria-hidden="true"
        {...(filled ? { fill: 'currentColor' } : {})}
        {...p}
      />
    )
  }
}

export const IconHome = icon(House)
export const IconPuzzle = icon(Puzzle)
export const IconUser = icon(CircleUserRound)
export const IconSettings = icon(Settings)
export const IconPlay = icon(Play, true)
export const IconStop = icon(Square, true)
export const IconPlus = icon(Plus)
export const IconFolder = icon(FolderOpen)
export const IconTerminal = icon(SquareTerminal)
export const IconSliders = icon(SlidersHorizontal)
export const IconSearch = icon(Search)
export const IconDownload = icon(Download)
export const IconCheck = icon(Check)
export const IconX = icon(X)
export const IconMinus = icon(Minus)
export const IconSquare = icon(Square)
export const IconTrash = icon(Trash2)
export const IconCoffee = icon(Coffee)
export const IconClock = icon(Clock)
export const IconCopy = icon(Copy)
export const IconExternal = icon(ExternalLink)
export const IconChevron = icon(ChevronDown)
export const IconHeart = icon(Heart)
export const IconCompass = icon(Compass)
export const IconGlobe = icon(Globe)
export const IconImage = icon(Images)
export const IconArchive = icon(Archive)
export const IconPackage = icon(Package)
export const IconUpload = icon(Upload)
export const IconAlert = icon(TriangleAlert)
export const IconArrowRight = icon(ArrowRight)
export const IconShirt = icon(Shirt)
export const IconCrown = icon(Crown)
export const IconServer = icon(Server)
export const IconRefresh = icon(RefreshCw)
export const IconUsers = icon(Users)
export const IconUserPlus = icon(UserPlus)
export const IconSend = icon(Send)

/** Логотип Microsoft (для кнопки входа) */
export const IconMicrosoft = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#f25022" d="M3 3h8.5v8.5H3z" />
    <path fill="#7fba00" d="M12.5 3H21v8.5h-8.5z" />
    <path fill="#00a4ef" d="M3 12.5h8.5V21H3z" />
    <path fill="#ffb900" d="M12.5 12.5H21V21h-8.5z" />
  </svg>
)

/** Логотип Hytpotchi: изометрический блок на мятном градиенте */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="hyt-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7cf7b8" />
          <stop offset="1" stopColor="#14a58c" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#hyt-bg)" />
      <path d="M32 13 49 22.5 32 32 15 22.5z" fill="#f2fff8" />
      <path d="M15 22.5 32 32v19L15 41.5z" fill="#0a3a2a" />
      <path d="M49 22.5 32 32v19l17-9.5z" fill="#0f5a40" />
      <path d="M15 22.5 32 32v4.5L15 27z" fill="#b9f5d6" />
      <path d="M49 22.5 32 32v4.5L49 27z" fill="#86e6b6" />
      <path d="M21 33.5h3v3h-3zM40 36h3v3h-3zM25 41.5h3v3h-3z" fill="#ffffff" opacity=".18" />
      <path d="M50 8.5l1.3 3.2 3.2 1.3-3.2 1.3L50 17.5l-1.3-3.2-3.2-1.3 3.2-1.3z" fill="#ffffff" />
    </svg>
  )
}
