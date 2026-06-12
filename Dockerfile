FROM python:3.9-slim

# Set environment variable to run python in unbuffered mode
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies (curl is useful for health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy and install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir beautifulsoup4==4.12.3

# Copy application files
COPY . .

# Create data directory for volume mounting
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
