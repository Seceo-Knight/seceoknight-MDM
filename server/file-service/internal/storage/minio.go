// Package storage wraps MinIO (S3-compatible) for blob persistence. We use
// presigned URLs for direct device downloads to avoid streaming bytes through
// our services.
package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const DefaultBucket = "mdm-files"

type Storage struct {
	cli        *minio.Client // internal Docker-network client (PUT / GET / stat)
	presignCli *minio.Client // browser-facing client used solely for PresignedGetObject
	bucket     string

	accessKey string
	secretKey string
}

// New constructs a Storage with two MinIO clients:
//
//   - cli       — talks to the internal Docker hostname (e.g. minio:9000)
//   - presignCli — generates download URLs whose host the user's BROWSER can
//                  reach. The S3 signature is computed over the request's
//                  Host header, so we must sign with the same host the browser
//                  will later send.
//
// publicEndpoint may include a scheme prefix ("http://localhost:9000"); we
// strip it because minio-go takes a bare host[:port].
func New(endpoint, publicEndpoint, accessKey, secretKey string, useSSL bool) (*Storage, error) {
	cli, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, err
	}
	pubHost, pubSecure := normalizeEndpoint(publicEndpoint, endpoint, useSSL)
	// Region must be set on the presign client. Without it, minio-go's
	// PresignedGetObject triggers a live GetBucketLocation HTTP call against
	// pubHost — but pubHost (e.g. localhost:9000) is the BROWSER-facing host
	// and is unreachable from inside this container. Pinning the region keeps
	// presign generation purely offline.
	presign, err := minio.New(pubHost, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: pubSecure,
		Region: "us-east-1",
	})
	if err != nil {
		return nil, err
	}
	return &Storage{
		cli:        cli,
		presignCli: presign,
		bucket:     DefaultBucket,
		accessKey:  accessKey,
		secretKey:  secretKey,
	}, nil
}

func (s *Storage) EnsureBucket(ctx context.Context) error {
	ok, err := s.cli.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	return s.cli.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{})
}

func (s *Storage) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	_, err := s.cli.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

// Get opens an object for reading from internal storage. Used by the audio
// session stitcher to read each segment and concatenate them.
func (s *Storage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.cli.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
}

// Stat returns an object's last-modified time and whether it exists, used to
// decide if a cached stitched session file is still up to date.
func (s *Storage) Stat(ctx context.Context, key string) (lastModified time.Time, exists bool, err error) {
	info, err := s.cli.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		resp := minio.ToErrorResponse(err)
		if resp.StatusCode == 404 || resp.Code == "NoSuchKey" {
			return time.Time{}, false, nil
		}
		return time.Time{}, false, err
	}
	return info.LastModified, true, nil
}

// PresignDownload returns a presigned GET URL signed against the default
// public endpoint (MINIO_PUBLIC_ENDPOINT). Use this only when there is no
// per-request hint available — admin browser traffic should use
// [PresignDownloadFor] so the URL matches whatever host the admin is
// currently reaching the server at.
func (s *Storage) PresignDownload(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.presignCli.PresignedGetObject(ctx, s.bucket, key, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignDownloadFor builds a presigned URL whose host is derived from the
// inbound HTTP request rather than the static MINIO_PUBLIC_ENDPOINT setting.
// publicEndpoint must include the scheme (`http://10.0.0.5` or
// `https://mdm.example.com`). Empty -> falls back to [PresignDownload].
//
// This lets the same admin server serve photos from any IP/DNS the admin
// happens to be hitting — bare-IP LAN, public DNS, port-forward, etc — without
// any config change. The cost is one minio.Client allocation per call, which
// is cheap (no network handshake; all SigV4 math is local).
func (s *Storage) PresignDownloadFor(ctx context.Context, key string, ttl time.Duration, publicEndpoint string) (string, error) {
	if publicEndpoint == "" {
		return s.PresignDownload(ctx, key, ttl)
	}
	pubHost, pubSecure := normalizeEndpoint(publicEndpoint, "", false)
	cli, err := minio.New(pubHost, &minio.Options{
		Creds:  credentials.NewStaticV4(s.accessKey, s.secretKey, ""),
		Secure: pubSecure,
		Region: "us-east-1",
	})
	if err != nil {
		return "", err
	}
	u, err := cli.PresignedGetObject(ctx, s.bucket, key, ttl, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *Storage) Delete(ctx context.Context, key string) error {
	return s.cli.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func KeyForApp(tenant, packageName string, versionCode int64) string {
	return fmt.Sprintf("apk/%s/%s/%d.apk", tenant, packageName, versionCode)
}

// normalizeEndpoint strips an optional scheme from `raw` and returns
// (hostPort, secure). If raw is empty, falls back to (fallback, fallbackSecure).
func normalizeEndpoint(raw, fallback string, fallbackSecure bool) (string, bool) {
	if raw == "" {
		return fallback, fallbackSecure
	}
	if strings.HasPrefix(raw, "https://") {
		return strings.TrimPrefix(raw, "https://"), true
	}
	if strings.HasPrefix(raw, "http://") {
		return strings.TrimPrefix(raw, "http://"), false
	}
	return raw, fallbackSecure
}
