// Package errors holds the canonical AppError type used by all services.
// Handlers return AppError to map to consistent HTTP status codes.
package errors

import (
	"errors"
	"fmt"
)

type Code string

const (
	CodeInvalidInput  Code = "invalid_input"
	CodeUnauthorized  Code = "unauthorized"
	CodeForbidden     Code = "forbidden"
	CodeNotFound      Code = "not_found"
	CodeConflict      Code = "conflict"
	CodeInternal      Code = "internal"
	CodeUnavailable   Code = "unavailable"
	CodeRateLimited   Code = "rate_limited"
)

type AppError struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
	Wrapped error  `json:"-"`
}

func (e *AppError) Error() string {
	if e.Wrapped != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Wrapped)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AppError) Unwrap() error { return e.Wrapped }

func New(code Code, msg string) *AppError {
	return &AppError{Code: code, Message: msg}
}

func Wrap(code Code, msg string, err error) *AppError {
	return &AppError{Code: code, Message: msg, Wrapped: err}
}

func HTTPStatus(err error) int {
	var e *AppError
	if !errors.As(err, &e) {
		return 500
	}
	switch e.Code {
	case CodeInvalidInput:
		return 400
	case CodeUnauthorized:
		return 401
	case CodeForbidden:
		return 403
	case CodeNotFound:
		return 404
	case CodeConflict:
		return 409
	case CodeRateLimited:
		return 429
	case CodeUnavailable:
		return 503
	default:
		return 500
	}
}
