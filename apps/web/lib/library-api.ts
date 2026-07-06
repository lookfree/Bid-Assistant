import { api, type RequestFn } from "./api"
import type { LibraryCategoryId, LibraryItem } from "./library"

// 资料库 CRUD 前端封装（GET/POST/PUT/DELETE /api/library，camelCase 契约）。
// 建在共享 api.request 上，鉴权头/baseUrl/401 语义全部复用；工厂形式便于测试注入 request。
// PUT 契约：缺键 = 不改，null = 清空（meta/expiry/body/fields/tags/attachments 均接受 null）。

/** 后端整行：前端条目形状 + 分类与时间戳 */
export type LibraryEntry = LibraryItem & {
  category: LibraryCategoryId
  createdAt: string
  updatedAt: string
}

/** 新增/更新入参（id 与时间戳由后端管理） */
export type LibraryEntryInput = Omit<LibraryEntry, "id" | "createdAt" | "updatedAt">

export function createLibraryApi(request: RequestFn) {
  return {
    listEntries: () => request<{ items: LibraryEntry[] }>("/api/library").then((r) => r.items),
    createEntry: (input: LibraryEntryInput) =>
      request<LibraryEntry>("/api/library", { method: "POST", body: JSON.stringify(input) }),
    updateEntry: (id: string, input: LibraryEntryInput) =>
      request<LibraryEntry>(`/api/library/${id}`, { method: "PUT", body: JSON.stringify(input) }),
    deleteEntry: (id: string) =>
      request<{ ok: boolean }>(`/api/library/${id}`, { method: "DELETE" }),
  }
}

export const libraryApi = createLibraryApi(api.request)
export const { listEntries, createEntry, updateEntry, deleteEntry } = libraryApi
