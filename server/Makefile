.PHONY: build up down logs seed test fmt vet tidy

SERVICES := auth-service device-service policy-service command-service telemetry-service notification-service file-service audit-service

build:
	docker compose build $(SERVICES) admin-web

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f $(SERVICES)

seed:
	docker compose exec -T postgres psql -U mdm -d mdm < scripts/seed.sql

tidy:
	@for s in shared $(SERVICES); do (cd $$s && go mod tidy) ; done

test:
	@for s in $(SERVICES); do (cd $$s && go test ./...) ; done

fmt:
	gofmt -s -w .

vet:
	@for s in $(SERVICES); do (cd $$s && go vet ./...) ; done
