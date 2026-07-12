import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 后端时间戳为 UTC ISO（timestamptz 序列化带 Z）；直接 slice 会晚 8 小时。
 *  统一按北京时区渲染成 "YYYY-MM-DD HH:mm:ss"（sv-SE 语言环境即此格式）。空/非法输入原样返回。 */
export function formatBeijing(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d)
}
