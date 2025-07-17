declare module 'archiver' {
  interface Archiver {
    directory(dirpath: string, destpath: string | false): Archiver;
    on(event: string, listener: Function): Archiver;
    pipe(stream: NodeJS.WritableStream): NodeJS.WritableStream;
    finalize(): void;
  }
  function archiver(format: string, options?: any): Archiver;
  export = archiver;
}
