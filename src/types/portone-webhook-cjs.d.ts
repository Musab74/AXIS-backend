declare module '@portone/server-sdk/webhook' {
  export function verify(
    secret: string | Uint8Array,
    payload: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown>;
}
