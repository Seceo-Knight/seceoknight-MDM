package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

func New(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         addr,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     20,
		MinIdleConns: 4,
	})
}

func Ping(ctx context.Context, c *redis.Client) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return c.Ping(ctx).Err()
}
