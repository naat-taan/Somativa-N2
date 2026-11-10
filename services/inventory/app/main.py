import os
import socket
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError

mongo = MongoClient(os.getenv("MONGO_URL", "mongodb://localhost:27017/inventory"))
items = mongo.get_database("inventory").get_collection("items")


class Reservation(BaseModel):
    sku: str
    quantity: int = Field(ge=1)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    for attempt in range(30):
        try:
            mongo.admin.command("ping")
            break
        except PyMongoError:
            if attempt == 29:
                raise
            time.sleep(2)
    items.create_index("sku", unique=True)
    for item in [
        {"sku": "SKU-001", "name": "Teclado", "stock": 100},
        {"sku": "SKU-002", "name": "Mouse", "stock": 50},
    ]:
        try:
            items.update_one({"sku": item["sku"]}, {"$setOnInsert": item}, upsert=True)
        except DuplicateKeyError:
            pass
    yield
    mongo.close()


app = FastAPI(title="Inventory Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/items")
@app.get("/api/inventory/items")
def list_items():
    return {
        "items": list(items.find({}, {"_id": 0})),
        "served_by": socket.gethostname(),
    }


@app.post("/reserve")
@app.post("/api/inventory/reserve")
def reserve(request: Reservation):
    updated = items.find_one_and_update(
        {"sku": request.sku, "stock": {"$gte": request.quantity}},
        {"$inc": {"stock": -request.quantity}},
        return_document=True,
        projection={"_id": 0},
    )
    if updated is None:
        if items.find_one({"sku": request.sku}, {"_id": 1}) is None:
            raise HTTPException(status_code=404, detail="SKU nao encontrado")
        raise HTTPException(status_code=409, detail="estoque insuficiente")
    return {"item": updated, "served_by": socket.gethostname()}