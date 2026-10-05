/**
 * ============================================================================
 *  Déclarations de types pour les modules sans typage publié
 * ============================================================================
 */

declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    text: string;
    version: string;
  }
  function pdfParse(
    data: Buffer | Uint8Array,
    options?: { max?: number; pagerender?: (page: unknown) => string },
  ): Promise<PdfParseResult>;
  export = pdfParse;
}

declare module 'jszip' {
  interface JSZipFile {
    async(type: 'string'): Promise<string>;
    async(type: 'nodebuffer'): Promise<Buffer>;
  }
  interface JSZipObject {
    file(path: string): JSZipFile | null;
    files: Record<string, JSZipFile>;
  }
  interface JSZipConstructor {
    loadAsync(data: Buffer | Uint8Array): Promise<JSZipObject>;
  }
  const JSZip: JSZipConstructor;
  export default JSZip;
}
