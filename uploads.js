// Image uploads via Cloudinary. Data never touches our disk (Railway's FS is
// ephemeral anyway) — we stream the bytes straight to Cloudinary and store only
// the returned URL.
//
// If the CLOUDINARY_* env vars are missing, this stays OFF and every call throws
// a clear error — a silently no-op upload endpoint is worse than one that says
// it isn't configured.
const cloudinary = require("cloudinary").v2;

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return false;
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
  return true;
}

function isConfigured() {
  return ensureConfigured();
}

// Upload a Buffer, return the secure CDN URL. Images are capped and auto-format/
// quality-optimised by Cloudinary so the owner can upload straight from a phone.
function uploadBuffer(buffer, { folder = "salia" } = {}) {
  if (!ensureConfigured()) return Promise.reject(new Error("uploads_not_configured"));
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        transformation: [{ width: 1600, height: 1600, crop: "limit" }, { quality: "auto", fetch_format: "auto" }],
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url)),
    );
    stream.end(buffer);
  });
}

// Upload a non-image file (e.g. a receipt PDF) as a raw asset. Returns the URL.
function uploadRaw(buffer, { folder = "salia/receipt", filename } = {}) {
  if (!ensureConfigured()) return Promise.reject(new Error("uploads_not_configured"));
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "raw", public_id: filename },
      (err, result) => (err ? reject(err) : resolve(result.secure_url)),
    );
    stream.end(buffer);
  });
}

module.exports = { isConfigured, uploadBuffer, uploadRaw };
