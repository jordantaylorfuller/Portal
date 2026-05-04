const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.STORJ_BUCKET;

const client = new S3Client({
  endpoint: process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.STORJ_ACCESS_KEY,
    secretAccessKey: process.env.STORJ_SECRET_KEY,
  },
  forcePathStyle: true,
});

async function presignPut(key, contentType, ttlSeconds = 900) {
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(client, cmd, { expiresIn: ttlSeconds });
}

async function presignGet(key, ttlSeconds = 60 * 60 * 24) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: ttlSeconds });
}

async function listPrefix(prefix, delimiter) {
  const keys = [];
  const folders = [];
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      Delimiter: delimiter,
      ContinuationToken: token,
    }));
    if (out.Contents) for (const o of out.Contents) keys.push({ key: o.Key, size: o.Size, etag: o.ETag, lastModified: o.LastModified });
    if (out.CommonPrefixes) for (const p of out.CommonPrefixes) folders.push(p.Prefix);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { keys, folders };
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { presignPut, presignGet, listPrefix, deleteObject };
