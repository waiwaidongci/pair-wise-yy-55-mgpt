declare module 'jsdom' {
  // jsdom 不随包发布类型声明，这里只声明测试用到的最小表面
  export interface JSDOMOptions { url?: string }
  export class JSDOM {
    constructor(html: string, options?: JSDOMOptions)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: any
  }
}
