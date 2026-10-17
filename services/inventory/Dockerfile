FROM golang:1.24-alpine AS build
WORKDIR /src
COPY services/inventory/go.mod services/inventory/go.sum ./
RUN go mod download
COPY services/inventory/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /inventory ./cmd/server

FROM alpine:3.21
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
COPY --from=build /inventory /inventory
USER app
EXPOSE 8081
ENTRYPOINT ["/inventory"]
