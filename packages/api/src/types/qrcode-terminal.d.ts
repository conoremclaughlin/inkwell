declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }

  type GenerateCallback = (qrcode: string) => void;

  const qrcodeTerminal: {
    generate(content: string, options?: GenerateOptions): void;
    generate(content: string, callback?: GenerateCallback): void;
    generate(content: string, options: GenerateOptions, callback: GenerateCallback): void;
  };

  export default qrcodeTerminal;
}
