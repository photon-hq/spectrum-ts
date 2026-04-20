import z from "zod";

export const readSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(Buffer)),
});

export const streamSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(ReadableStream)),
});

export const bufferToStream = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
