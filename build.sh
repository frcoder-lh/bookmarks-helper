#!/bin/bash

# 创建output目录
mkdir -p output

# 打包crx所需文件到output目录（不包含src目录，只包含其内容）
cd src && zip -r ../output/BookmarksHelper.zip . && cd ..

echo "Build completed! Zip file created at output/BookmarksHelper.zip"
