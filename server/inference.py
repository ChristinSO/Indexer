"""One spawned process owns the model and all GPU allocations."""
import os
import time


def worker(connection, snapshot, mode):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import numpy as np
        import psutil
        import torch
        from PIL import Image, ImageOps
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(4)
        device = "cuda" if mode != "cpu" and torch.cuda.is_available() else "cpu"
        dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
        model = SentenceTransformer(snapshot, device=device, local_files_only=True,
                                    config_kwargs={"audio_config": None},
                                    model_kwargs={"torch_dtype": dtype})
        model.eval()
        connection.send({"ok": True, "device": device, "dtype": str(dtype), "parameters": sum(p.numel() for p in model.parameters())})
        while True:
            request = connection.recv()
            if request["kind"] == "stop":
                return
            started = time.perf_counter()
            try:
                with torch.inference_mode():
                    if request["kind"] == "image":
                        with Image.open(request["value"]) as source:
                            if source.width * source.height * 16 + 256 * 1024**2 > psutil.virtual_memory().available:
                                raise ValueError("Not enough free memory to decode this photo safely.")
                            oriented = ImageOps.exif_transpose(source)
                            image = oriented.convert("RGB")
                            try:
                                vector = model.encode({"image": image}, batch_size=1, normalize_embeddings=True,
                                                      convert_to_numpy=True, show_progress_bar=False,
                                                      processing_kwargs={"image": {"max_soft_tokens": 280}})
                            finally:
                                image.close()
                                if oriented is not source:
                                    oriented.close()
                    else:
                        vector = model.encode(request["value"], prompt_name="SearchQuery", normalize_embeddings=True,
                                              convert_to_numpy=True, show_progress_bar=False)
                vector = np.asarray(vector, dtype=np.float32).reshape(-1)
                norm = float(np.linalg.norm(vector))
                if vector.shape != (768,) or not np.isfinite(vector).all() or norm < 1e-8:
                    raise ValueError("The model produced an invalid embedding.")
                vector /= norm
                connection.send({"ok": True, "vector": vector.tobytes(), "milliseconds": (time.perf_counter()-started)*1000,
                                 "rss": psutil.Process().memory_info().rss,
                                 "gpu_allocated": torch.cuda.memory_allocated() if device == "cuda" else 0,
                                 "gpu_reserved": torch.cuda.memory_reserved() if device == "cuda" else 0})
                del vector
            except Exception as error:
                oom = isinstance(error, torch.OutOfMemoryError)
                connection.send({"ok": False, "error": str(error), "oom": oom})
                if oom:
                    return
    except Exception as error:
        connection.send({"ok": False, "error": str(error)})
    finally:
        connection.close()
