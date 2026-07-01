import uvicorn
from agent.app import create_app
from agent.config import settings

app = create_app()

if __name__ == "__main__":
    uvicorn.run("agent.main_api:app", host="0.0.0.0", port=settings.port, reload=True)
