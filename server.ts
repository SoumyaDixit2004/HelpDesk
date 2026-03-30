import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import multer from "multer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.post("/api/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
    });
  });

  app.get("/api/files", (req, res) => {
    const files = fs.readdirSync(UPLOADS_DIR).map((filename) => ({
      filename,
      originalName: filename.split("-").slice(1).join("-"),
    }));
    res.json(files);
  });

  app.get("/api/files/:filename", (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const content = fs.readFileSync(filePath);
    res.json({
      base64: content.toString("base64"),
      mimeType: "application/pdf",
    });
  });

  app.delete("/api/files/:filename", (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
