package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"

	"github.com/mdm/device-service/internal/dto"
	"github.com/mdm/device-service/internal/repository"
	apperr "github.com/mdm/shared/errors"
	"github.com/mdm/shared/events"
	"github.com/mdm/shared/models"
	"github.com/mdm/shared/mq"
)

type GroupService struct {
	groups *repository.GroupRepo
	bus    *mq.Bus
}

func NewGroupService(g *repository.GroupRepo, bus *mq.Bus) *GroupService {
	return &GroupService{groups: g, bus: bus}
}

func (s *GroupService) List(ctx context.Context, tenantID uuid.UUID) ([]models.DeviceGroup, error) {
	return s.groups.List(ctx, tenantID)
}

func (s *GroupService) Create(ctx context.Context, tenantID, actorID uuid.UUID, in dto.CreateGroupRequest) (*models.DeviceGroup, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, apperr.New(apperr.CodeInvalidInput, "group name is required")
	}
	g := &models.DeviceGroup{TenantID: tenantID, Name: name, Description: in.Description}
	if err := s.groups.Create(ctx, g); err != nil {
		return nil, apperr.Wrap(apperr.CodeInternal, "create group", err)
	}
	s.audit(ctx, tenantID, actorID, "group.created", g.ID, map[string]any{"name": name})
	return g, nil
}

func (s *GroupService) Update(ctx context.Context, tenantID, actorID, id uuid.UUID, in dto.UpdateGroupRequest) error {
	var name *string
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" {
			return apperr.New(apperr.CodeInvalidInput, "group name cannot be empty")
		}
		name = &n
	}
	if err := s.groups.Update(ctx, tenantID, id, name, in.Description); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "group not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "update group", err)
	}
	s.audit(ctx, tenantID, actorID, "group.updated", id, nil)
	return nil
}

func (s *GroupService) Delete(ctx context.Context, tenantID, actorID, id uuid.UUID) error {
	if err := s.groups.Delete(ctx, tenantID, id); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return apperr.New(apperr.CodeNotFound, "group not found")
		}
		return apperr.Wrap(apperr.CodeInternal, "delete group", err)
	}
	s.audit(ctx, tenantID, actorID, "group.deleted", id, nil)
	return nil
}

func (s *GroupService) audit(ctx context.Context, tenantID, actorID uuid.UUID, action string, groupID uuid.UUID, meta map[string]any) {
	var metaJSON json.RawMessage
	if meta != nil {
		metaJSON, _ = json.Marshal(meta)
	}
	env := events.AuditEnvelope{
		TenantID:   tenantID.String(),
		ActorKind:  "user",
		Action:     action,
		TargetKind: events.StrPtr("group"),
		TargetID:   events.UUIDStrPtr(groupID),
		Metadata:   metaJSON,
	}
	if actorID != uuid.Nil {
		env.ActorID = events.UUIDStrPtr(actorID)
	}
	events.Emit(ctx, s.bus, env)
}
