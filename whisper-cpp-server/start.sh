#LD_LIBRARY_PATH=/home/sadai/Documents/docker/whisper-flow-backend/whisper.cpp/build/bin /home/sadai/Documents/docker/whisper-flow-backend/whisper.cpp/build/bin/whisper-server \
LD_LIBRARY_PATH= ./whisper-bin-ubuntu-x64/whisper-server \
-m ./models/ggml-base.en.bin \
--port 8001 \
--host 127.0.0.1
