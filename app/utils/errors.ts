/** 从接口错误里取出给用户看的说明：优先用后端返回的 message */
export const errorMessage = (e: unknown): string =>
  (e as { data?: { message?: string } }).data?.message ?? (e as Error).message ?? '未知错误'
