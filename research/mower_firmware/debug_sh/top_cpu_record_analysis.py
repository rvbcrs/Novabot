#!usr/bin/env python3
# encoding=utf-8

"""
//
// Created by zxl on 2022/4/26.
//

type cmd like: top -d 1|grep python > cpu_record.txt
then:  python3 top_cpu_record_analysis.py cpu_record.txt
"""

import matplotlib.pyplot as plt
import os
import math
import sys
import re


def read_txt(filename):
    with open(filename, "r", encoding="utf-8") as f:
        text = f.read().strip()
    samples = text.split("\n")
    return samples


def cpu_and_memery_analysis(filename):
    samples = read_txt(filename)
    cpu = {}
    memory = {}
    times = {}
    mean_len = sum([len(sample.split(" ")) for sample in samples]) / len(samples)
    for sample in samples:
        if (len(sample.strip()) < 10):
            continue
        clean_str = re.sub("[^\w:\.]", " ", sample)[:100]
        temp_data = clean_str.split(" ")
        # if(len(temp_data)<mean_len):
        #     continue
        data = [i for i in temp_data if i.strip()]
        try:
            float(data[-4])
            float(data[-3])
        except:
            continue
        if data[-1] not in cpu.keys():
            cpu.update({data[-1]: []})
            memory.update({data[-1]: []})
            times.update({data[-1]: []})
        cpu[data[-1]].append(float(data[-4]))
        memory[data[-1]].append(float(data[-3]))
        times[data[-1]].append((data[-2]))
    # name.append(data[-2])
    plot_data(cpu, memory, filename)
    return cpu, memory, times


def plot_data(cpu, memory, filename):
    # figure = plt.figure(figsize=(18,19))
    # max_length = max([len(v) for k,v in cpu.items])
    # fx, ax = plt.subplots(len(cpu.keys()), 1, figsize=(18,18))
    n = 0
    plt.cla()
    for key, value in cpu.items():
        print(key)
        plt.title('cpu_anaysis')
        plt.plot(range(len(value)), value,
                 label=key + "  mean:" + str(sum(value) / len(value))[:6] + "   max:" + str(max(value))[:6])
        plt.legend()
        plt.ylabel('cpu(%)')
        n += 1
    plt.savefig(
        "{}/{}_cpu_anaysis.png".format(os.path.split(filename)[0], os.path.splitext(os.path.basename(filename))[0]))
    plt.cla()
    plt.title("memory_anaysis")
    for key, value in memory.items():
        plt.plot(range(len(value)), value,
                 label=key + "   mean:" + str(sum(value) / len(value))[:6] + "   max:" + str(max(value))[:6])
        # ax[n].plot(range(value), [mean] * len(x), color='orange', label='mean cpu occupancy')
        plt.legend()
        plt.ylabel('cpu(%)')
        n += 1
    plt.savefig(
        "{}/{}_memory_anaysis.png".format(os.path.split(filename)[0], os.path.splitext(os.path.basename(filename))[0]))


if __name__ == '__main__':
    print('Usage:  python3 top_cpu_record_analysis.py cpu_record.txt')
    if (len(sys.argv) < 2):
        print("---------------------Please set file path!!!")
    print(sys.argv)
    directory = os.path.split(os.path.abspath(sys.argv[1]))[0]
    filename = os.path.split(os.path.abspath(sys.argv[1]))[1]
    print(directory, filename)
    cpu_and_memery_analysis("{}/{}".format(directory, filename))
