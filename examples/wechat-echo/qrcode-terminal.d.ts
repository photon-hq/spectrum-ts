// qrcode-terminal ships no types; this is the one call the example uses.
declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, options?: { small?: boolean }): void;
  };
  export default qrcode;
}
