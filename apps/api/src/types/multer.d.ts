/**
 * Minimal Express.Multer.File declaration.
 *
 * @types/multer pulls in the whole multer surface for one interface; the upload
 * controller only ever touches these fields.
 */
declare global {
  namespace Express {
    namespace Multer {
      interface File {
        fieldname: string;
        originalname: string;
        mimetype: string;
        size: number;
        buffer: Buffer;
      }
    }
  }
}
export {};
