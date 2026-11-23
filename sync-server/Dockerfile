FROM python:3.12-alpine
WORKDIR /app
COPY server.py /app/server.py
RUN adduser -D -u 10001 app && mkdir -p /app/data && chown -R app:app /app/data
USER app
ENV LKS_DATA=/app/data LKS_HOST=0.0.0.0 LKS_PORT=8791
EXPOSE 8791
CMD ["python3", "-u", "server.py"]
