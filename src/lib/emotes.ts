import {
  CrouchAnimation,
  FlyingAnimation,
  FunctionAnimation,
  HitAnimation,
  IdleAnimation,
  RunningAnimation,
  WalkingAnimation,
  type PlayerAnimation,
  type PlayerObject,
} from 'skinview3d'

/**
 * Позы и эмоции для 3D-предпросмотра скина.
 *
 * Оси skinview3d: рука висит вниз; rotation.x = -π/2 — рука вперёд, ±π — вверх.
 * Левая рука находится на +x: rotation.z > 0 отводит её в сторону, у правой — наоборот.
 * progress анимации растёт в секундах (при speed = 1).
 */

export type EmoteId =
  | 'idle'
  | 'walk'
  | 'run'
  | 'crouch'
  | 'fly'
  | 'wave'
  | 'dance'
  | 'clap'
  | 'bow'
  | 'cheer'
  | 'yes'
  | 'no'
  | 'punch'
  | 'spin'

export interface Emote {
  id: EmoteId
  label: string
  emoji: string
  group: 'pose' | 'emote'
  /** Длительность разовой эмоции в секундах; без неё анимация крутится бесконечно */
  duration?: number
  make: () => PlayerAnimation
}

const TAU = Math.PI * 2
const ARM_Z = Math.PI * 0.02

/** Лёгкое «дыхание», чтобы во время эмоций персонаж не застывал */
function breathe(p: PlayerObject, t: number) {
  p.skin.leftArm.rotation.z = Math.cos(t * 2) * 0.03 + ARM_Z
  p.skin.rightArm.rotation.z = Math.cos(t * 2 + Math.PI) * 0.03 - ARM_Z
  p.cape.rotation.x = Math.sin(t * 2) * 0.03 + Math.PI * 0.06
}

/** 0 → 1 → 0 по синусу за duration секунд: плавно войти в позу и выйти из неё */
function bell(t: number, duration: number) {
  const x = Math.min(Math.max(t / duration, 0), 1)
  return Math.sin(x * Math.PI)
}

/** Плавное вхождение в позу за первые `ramp` секунд и выход за последние */
function envelope(t: number, duration: number, ramp = 0.3) {
  const a = Math.min(t / ramp, 1)
  const b = Math.min(Math.max((duration - t) / ramp, 0), 1)
  const e = Math.min(a, b)
  return e * e * (3 - 2 * e)
}

const fn = (f: (p: PlayerObject, t: number) => void) => () => new FunctionAnimation(f)

export const EMOTES: Emote[] = [
  { id: 'idle', label: 'Стоять', emoji: '🧍', group: 'pose', make: () => new IdleAnimation() },
  { id: 'walk', label: 'Ходьба', emoji: '🚶', group: 'pose', make: () => new WalkingAnimation() },
  { id: 'run', label: 'Бег', emoji: '🏃', group: 'pose', make: () => new RunningAnimation() },
  { id: 'crouch', label: 'Присесть', emoji: '🧎', group: 'pose', make: () => new CrouchAnimation() },
  { id: 'fly', label: 'Полёт', emoji: '🕊️', group: 'pose', make: () => new FlyingAnimation() },

  {
    id: 'wave',
    label: 'Привет',
    emoji: '👋',
    group: 'emote',
    duration: 2.6,
    make: fn((p, t) => {
      breathe(p, t)
      const e = envelope(t, 2.6)
      p.skin.rightArm.rotation.x = -Math.PI * 0.95 * e
      p.skin.rightArm.rotation.z = -ARM_Z - (0.25 + Math.sin(t * TAU * 1.6) * 0.35) * e
      p.skin.head.rotation.z = -0.12 * e
      p.skin.head.rotation.y = 0.15 * e
    }),
  },
  {
    id: 'dance',
    label: 'Танец',
    emoji: '🕺',
    group: 'emote',
    make: fn((p, t) => {
      const b = t * TAU * 1.1
      p.position.y = Math.abs(Math.sin(b)) * 1.4
      p.rotation.y = Math.sin(b / 2) * 0.45
      p.skin.leftArm.rotation.x = -Math.PI * 0.5 - Math.sin(b) * Math.PI * 0.45
      p.skin.rightArm.rotation.x = -Math.PI * 0.5 + Math.sin(b) * Math.PI * 0.45
      p.skin.leftArm.rotation.z = 0.25 + Math.cos(b) * 0.2
      p.skin.rightArm.rotation.z = -0.25 + Math.cos(b) * 0.2
      p.skin.leftLeg.rotation.x = Math.max(0, Math.sin(b)) * -0.6
      p.skin.rightLeg.rotation.x = Math.max(0, -Math.sin(b)) * -0.6
      p.skin.head.rotation.z = Math.sin(b) * 0.15
      p.skin.head.rotation.x = Math.abs(Math.cos(b)) * 0.12
      p.cape.rotation.x = Math.PI * 0.06 + Math.abs(Math.sin(b)) * 0.35
    }),
  },
  {
    id: 'clap',
    label: 'Хлопки',
    emoji: '👏',
    group: 'emote',
    duration: 2.6,
    make: fn((p, t) => {
      breathe(p, t)
      const e = envelope(t, 2.6)
      const close = (1 + Math.sin(t * TAU * 2.4)) / 2
      p.skin.leftArm.rotation.x = -Math.PI * 0.42 * e
      p.skin.rightArm.rotation.x = -Math.PI * 0.42 * e
      p.skin.leftArm.rotation.z = (-0.12 - 0.3 * close) * e + ARM_Z * (1 - e)
      p.skin.rightArm.rotation.z = (0.12 + 0.3 * close) * e - ARM_Z * (1 - e)
      p.skin.head.rotation.x = 0.1 * e
    }),
  },
  {
    id: 'bow',
    label: 'Поклон',
    emoji: '🙇',
    group: 'emote',
    duration: 2.2,
    make: fn((p, t) => {
      breathe(p, t)
      const e = bell(t, 2.2)
      p.rotation.x = 0.45 * e
      p.position.z = 2.5 * e
      p.position.y = -1.5 * e
      p.skin.head.rotation.x = 0.35 * e
      p.skin.rightArm.rotation.x = -0.7 * e
      p.skin.rightArm.rotation.z = 0.35 * e - ARM_Z
      p.skin.leftArm.rotation.x = 0.35 * e
      p.cape.rotation.x = Math.PI * 0.06 + 0.4 * e
    }),
  },
  {
    id: 'cheer',
    label: 'Ура!',
    emoji: '🙌',
    group: 'emote',
    make: fn((p, t) => {
      const b = t * TAU * 1.3
      const up = Math.abs(Math.sin(b))
      p.position.y = up * 2.2
      p.skin.leftArm.rotation.x = Math.PI
      p.skin.rightArm.rotation.x = Math.PI
      p.skin.leftArm.rotation.z = 0.45 + up * 0.15
      p.skin.rightArm.rotation.z = -0.45 - up * 0.15
      p.skin.leftLeg.rotation.z = up * 0.12
      p.skin.rightLeg.rotation.z = -up * 0.12
      p.skin.head.rotation.x = -0.25
      p.cape.rotation.x = Math.PI * 0.06 + up * 0.5
    }),
  },
  {
    id: 'yes',
    label: 'Да',
    emoji: '👍',
    group: 'emote',
    duration: 1.6,
    make: fn((p, t) => {
      breathe(p, t)
      p.skin.head.rotation.x = Math.sin(t * TAU * 2) * 0.35 * envelope(t, 1.6, 0.2)
    }),
  },
  {
    id: 'no',
    label: 'Нет',
    emoji: '🙅',
    group: 'emote',
    duration: 1.6,
    make: fn((p, t) => {
      breathe(p, t)
      p.skin.head.rotation.y = Math.sin(t * TAU * 2) * 0.55 * envelope(t, 1.6, 0.2)
    }),
  },
  { id: 'punch', label: 'Удар', emoji: '👊', group: 'emote', duration: 2, make: () => new HitAnimation() },
  {
    id: 'spin',
    label: 'Кружение',
    emoji: '🌀',
    group: 'emote',
    make: fn((p, t) => {
      p.rotation.y = t * TAU * 0.7
      p.position.y = Math.abs(Math.sin(t * TAU * 1.4)) * 0.6
      p.skin.leftArm.rotation.z = Math.PI * 0.45
      p.skin.rightArm.rotation.z = -Math.PI * 0.45
      p.skin.head.rotation.x = -0.15
      p.cape.rotation.x = Math.PI * 0.06 + 0.9
    }),
  },
]

export const emoteById = (id: EmoteId) => EMOTES.find((e) => e.id === id) ?? EMOTES[0]
