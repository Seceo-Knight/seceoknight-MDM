package dispatcher

import (
	"context"
	"reflect"
	"unsafe"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/mdm/command-service/internal/repository"
)

// repoSelect is a small helper that lets the dispatcher run an ad-hoc query
// against the same *sqlx.DB the repository owns, without exposing the field.
// We use reflect to grab the unexported `db` field. (Cleaner alternative:
// expose a Querier method on the repo — kept as a single tightly-scoped use
// here to keep the repo surface area minimal.)
func repoSelect(r *repository.CommandRepo, ctx context.Context, dest any, q string, args ...any) error {
	v := reflect.ValueOf(r).Elem().FieldByName("db")
	v = reflect.NewAt(v.Type(), unsafe.Pointer(v.UnsafeAddr())).Elem()
	db := v.Interface().(*sqlx.DB)
	return db.SelectContext(ctx, dest, q, args...)
}

// uuidLite is a UUID that scans from the `uuid` Postgres type.
type uuidLite = uuid.UUID
