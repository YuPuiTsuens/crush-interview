import RaydiumSwap from './RaydiumSwap';
import {Transaction, VersionedTransaction} from '@solana/web3.js';
import 'dotenv/config';
import {swapConfig} from './swapConfig';


const main = async () => {
    const raydiumSwap = new RaydiumSwap(process.env.SOL_RPC_URL, process.env.WALLET_PRIVATE_KEY);
    console.log(`Raydium swap initialized`);
    console.log(`Swapping ${swapConfig.tokenAAmount} of ${swapConfig.tokenAAddress} for ${swapConfig.tokenBAddress}...`)

    console.log(`Load pool keys from the Raydium API to enable finding pool information`);
    await raydiumSwap.loadPoolKeys(swapConfig.liquidityFile);

    console.log("Find pool information for the given token pair.")
    const poolInfo = raydiumSwap.findPoolInfoForTokens(swapConfig.tokenAAddress, swapConfig.tokenBAddress);
    if (!poolInfo) {
        console.error('Pool info not found');
        return 'Pool info not found';
    } else {
        console.log('Found pool info');
    }

    console.log("Prepare the swap transaction with the given parameters.")
    const tx = await raydiumSwap.getSwapTransaction(
        swapConfig.tokenBAddress,
        swapConfig.tokenAAmount,
        poolInfo,
        swapConfig.maxLamports,
        swapConfig.useVersionedTransaction,
        swapConfig.direction
    );

    console.log("Depending on the configuration, execute or simulate the swap.")
    if (swapConfig.executeSwap) {
        console.log("Send the transaction to the network and log the transaction ID.")
        const txid = swapConfig.useVersionedTransaction
            ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
            : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);

        console.log(`https://solscan.io/tx/${txid}`);

    } else {
        console.log("Simulate the transaction and log the result.")
        const simRes = swapConfig.useVersionedTransaction
            ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
            : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);

        console.log(simRes);
    }
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });