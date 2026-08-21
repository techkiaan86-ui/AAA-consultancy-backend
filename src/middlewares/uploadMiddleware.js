const multer = require('multer');
const path = require('path');
const fs = require('fs');

const isAwsConfigured = process.env.AWS_ACCESS_KEY_ID && 
  process.env.AWS_SECRET_ACCESS_KEY && 
  process.env.AWS_BUCKET_NAME && 
  !process.env.AWS_ACCESS_KEY_ID.includes('your_aws');

let storage;

if (isAwsConfigured) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: process.env.AWS_REGION || 'eu-west-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    // Custom S3 Multer Engine
    storage = {
      _handleFile: function (req, file, cb) {
        const { Upload } = require('@aws-sdk/lib-storage');
        const filename = `${Date.now()}-${file.originalname}`;
        const upload = new Upload({
          client: s3,
          params: {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: `documents/${filename}`,
            Body: file.stream,
            ContentType: file.mimetype
          }
        });

        upload.done()
          .then(data => cb(null, { filename, location: data.Location, size: file.size, originalname: file.originalname }))
          .catch(err => cb(err));
      },
      _removeFile: function (req, file, cb) {
        cb(null);
      }
    };
    console.log('[Upload Engine] Configured AWS S3 Cloud Storage Engine.');
  } catch (err) {
    console.warn('[Upload Engine] AWS S3 setup failed, falling back to Local Storage:', err.message);
  }
}

if (!storage) {
  // Ensure local uploads directory exists
  const uploadDir = path.join(__dirname, '../../uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
      const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const truncated = cleanName.length > 60 ? cleanName.substring(cleanName.length - 60) : cleanName;
      cb(null, Date.now() + '-' + truncated);
    }
  });
}

const upload = multer({ storage: storage });

module.exports = upload;
