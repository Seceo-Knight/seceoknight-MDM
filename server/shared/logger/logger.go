// Package logger configures a service-wide zerolog logger that emits structured
// JSON in production and pretty console output in development.
package logger

import (
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func Init(service, env, level string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)
	zerolog.TimeFieldFormat = time.RFC3339Nano

	var l zerolog.Logger
	if env == "development" {
		l = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: "15:04:05"}).With().
			Timestamp().Str("svc", service).Logger()
	} else {
		l = zerolog.New(os.Stdout).With().Timestamp().Str("svc", service).Logger()
	}
	log.Logger = l
	return l
}
